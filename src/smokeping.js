const { getConfig } = require("raraph84-lib");
const { median, alert, splitEmbed } = require("./utils");
const net = require("net");
const ping = require("net-ping");
const config = getConfig(__dirname + "/..");

const aggregations = [
    { duration: 1, storage: 7 }, // 10s for 1 week
    { duration: 3, storage: 14 }, // 30s for 2 weeks
    { duration: 6, storage: 28 }, // 1m for ~1 month
    { duration: 6 * 5, storage: 84 }, // 5m for ~3 months
    { duration: 6 * 10, storage: 364 } // 10m for ~1 year
];

let smokepingInterval = null;
let aggregateInterval = null;

/**
 * @param {import("mysql2/promise").Pool} database
 */
module.exports.init = async (database) => {
    let checker;
    try {
        checker = (await database.query("SELECT * FROM checkers WHERE checker_id=?", [config.checkerId]))[0][0];
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        throw error;
    }

    if (!checker) throw new Error("Checker does not exist.");

    await aggregate(database);

    smokepingInterval = setInterval(() => smokeping(database, checker), 2000);
    aggregateInterval = setInterval(() => aggregate(database), 10 * 60 * 1000);
};

module.exports.stop = async () => {
    clearInterval(smokepingInterval);
    clearInterval(aggregateInterval);
};

/** @type {{ time: number; id: string; latency: number | null; error: any | null; }[]} */
let pings = [];
/** @type {{ id: number; service: any; ip: string; }[]} */
let smokepingServices = [];

const v4session = new ping.Session({
    networkProtocol: ping.NetworkProtocol.IPv4,
    timeout: 1000,
    packetSize: 64,
    ttl: 64,
    retries: 0
});

const v6session = new ping.Session({
    networkProtocol: ping.NetworkProtocol.IPv6,
    timeout: 1000,
    packetSize: 64,
    ttl: 64,
    retries: 0
});

/**
 * @param {import("mysql2/promise").Pool} database
 */
const smokeping = async (database, checker) => {
    const time = Math.floor(Date.now() / 1000 / 10);

    smokepingServices.forEach((service, i) =>
        setTimeout(
            () => {
                const session = net.isIPv4(service.ip) ? v4session : v6session;
                session.pingHost(service.ip, (error, _target, sent, rcvd) => {
                    if (error) pings.push({ time, id: service.id, latency: null, error });
                    else
                        pings.push({
                            time,
                            id: service.id,
                            latency: Math.round(Number(rcvd - sent) / 10),
                            error: null
                        });
                });
            },
            (2000 / smokepingServices.length) * i
        )
    );

    const times = pings
        .filter((ping) => ping.time <= time - 2)
        .map((ping) => ping.time)
        .filter((t, i, a) => a.indexOf(t) === i);
    const checks = [];
    for (const time of times) {
        const timePings = pings.filter((ping) => ping.time === time);
        pings = pings.filter((ping) => ping.time !== time);

        const services = timePings.map((service) => service.id).filter((s, i, a) => a.indexOf(s) === i);
        for (const service of services) {
            const servicePings = timePings.filter((ping) => ping.id === service);
            if (servicePings.length !== 5) continue;

            checks.push({
                service: smokepingServices.find((s) => s.id === service).service,
                time,
                pings: servicePings.map((ping) => ({ latency: ping.latency, error: ping.error }))
            });
        }
    }

    if (checks.length) {
        let states = null;
        try {
            states = await getServicesStates(
                database,
                checks.map((check) => check.service.service_id)
            );
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }

        const inserts = [];
        for (const check of checks) {
            const latencies = check.pings.filter((ping) => ping.latency).map((ping) => ping.latency);
            const downs = latencies.length ? null : 1;
            const med = latencies.length ? median(latencies) : null;
            const min = latencies.length ? Math.min(...latencies) : null;
            const max = latencies.length ? Math.max(...latencies) : null;
            const lost = check.pings.length - latencies.length || null;

            inserts.push([check.service.service_id, config.checkerId, check.time, 1, 1, downs, med, min, max, lost]);
        }

        let failed = false;
        try {
            await database.query(
                "INSERT INTO services_smokeping (service_id, checker_id, start_time, duration, checks, downs, med_response_time, min_response_time, max_response_time, lost) VALUES " +
                    inserts.map(() => "(?)").join(", ") +
                    " ON DUPLICATE KEY UPDATE service_id=service_id",
                inserts
            );
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
            failed = true;
        }

        if (failed) {
            const tempDatabase = require("./database").getTempDatabase();
            for (const insert of inserts) {
                try {
                    await tempDatabase.run(
                        "INSERT INTO services_smokeping (service_id, checker_id, start_time, duration, checks, downs, med_response_time, min_response_time, max_response_time, lost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        insert
                    );
                } catch (error) {
                    console.log(`SQL Error - ${__filename} - ${error}`);
                }
            }
        }

        if (states) {
            const offlineChecks = [];
            const onlineChecks = [];
            for (const check of checks) {
                const oldUp = states.find((state) => state.service === check.service.service_id)?.online ?? false;
                const up = check.pings.some((ping) => ping.latency);
                if (up && !oldUp) onlineChecks.push(check);
                else if (!up && oldUp) offlineChecks.push(check);
            }

            if (offlineChecks.length) {
                const everyone = offlineChecks.some((check) => check.service.alert) ? "@everyone " : "";
                const content = `${everyone}**${offlineChecks.length} Service${offlineChecks.length > 1 ? "s" : ""} hors ligne** pour ${checker.name} ${checker.location}`;
                const embeds = splitEmbed({
                    title: `Services hors ligne pour ${checker.name} ${checker.location}`,
                    description: offlineChecks
                        .map((check) => {
                            const failedPing =
                                check.pings.find((ping) => ping.error && ping.error.name !== "RequestTimedOutError") ??
                                check.pings.find((ping) => ping.error);
                            return `:warning: **Le service **\`${check.service.name}\`** est hors ligne.**\n${failedPing.error.toString()}`;
                        })
                        .join("\n"),
                    timestamp: new Date(offlineChecks[0].time * 10 * 1000),
                    color: (0xff0000).toString()
                });
                try {
                    for (const embed of embeds)
                        await alert({
                            ...(embeds.indexOf(embed) === 0 ? { content } : {}),
                            embeds: [embed]
                        });
                } catch (error) {
                    console.log("Cannot send alert - " + error);
                }
            }

            if (onlineChecks.length) {
                const everyone = onlineChecks.some((check) => check.service.alert) ? "@everyone " : "";
                const content = `${everyone}**${onlineChecks.length} Service${onlineChecks.length > 1 ? "s" : ""} en ligne** pour ${checker.name} ${checker.location}`;
                const embeds = splitEmbed({
                    title: `Services en ligne pour ${checker.name} ${checker.location}`,
                    description: onlineChecks
                        .map((check) => {
                            return `:warning: **Le service **\`${check.service.name}\`** est de nouveau en ligne.**`;
                        })
                        .join("\n"),
                    timestamp: new Date(onlineChecks[0].time * 10 * 1000),
                    color: (0x00ff00).toString()
                });
                try {
                    for (const embed of embeds)
                        await alert({
                            ...(embeds.indexOf(embed) === 0 ? { content } : {}),
                            embeds: [embed]
                        });
                } catch (error) {
                    console.log("Cannot send alert - " + error);
                }
            }
        }
    }
};

module.exports.updateServices = () => {
    const services = require("./services")
        .getServices()
        .filter((service) => service.type === "server" && !service.disabled);

    smokepingServices = smokepingServices.filter((service) => services.some((s) => service.id === s.service_id));

    for (const service of services) {
        if (!service.ip) continue;
        const old = smokepingServices.find((s) => s.id === service.service_id);
        if (old) {
            old.ip = service.ip;
            old.service = service;
        } else smokepingServices.push({ id: service.service_id, service, ip: service.ip });
    }
};

let aggregating = false;

/**
 * @param {import("mysql2/promise").Pool} database
 */
const aggregate = async (database) => {
    if (aggregating) return;
    aggregating = true;

    console.log("Aggregating smokeping data...");

    const time = Math.floor(Date.now() / 1000 / 10);

    for (const aggregation of aggregations.slice(1)) {
        const prevAggregation = aggregations[aggregations.indexOf(aggregation) - 1];
        const startTime =
            Math.floor((time - prevAggregation.storage * 24 * 60 * 6) / aggregation.duration) * aggregation.duration;

        let pings;
        try {
            [pings] = await database.query(
                "SELECT * FROM services_smokeping WHERE checker_id=? AND start_time<? AND duration=?",
                [config.checkerId, startTime, prevAggregation.duration]
            );
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
            aggregating = false;
            return;
        }

        if (!pings.length) continue;

        const services = [];
        for (const ping of pings) {
            const service = services.find((service) => service.id === ping.service_id);
            const startTime = Math.floor(ping.start_time / aggregation.duration) * aggregation.duration;
            if (!service) {
                services.push({ id: ping.service_id, pings: [ping], startTimes: [{ startTime, pings: [ping] }] });
            } else {
                service.pings.push(ping);
                const oldStartTime = service.startTimes.find((oldStartTime) => oldStartTime.startTime === startTime);
                if (!oldStartTime) service.startTimes.push({ startTime, pings: [ping] });
                else oldStartTime.pings.push(ping);
            }
        }

        const inserts = [];
        for (const service of services) {
            for (const startTime of service.startTimes) {
                const checks = startTime.pings.reduce((acc, ping) => acc + ping.checks, 0);
                const downs = startTime.pings.reduce((acc, ping) => acc + (ping.downs ?? 0), 0) || null;
                const working = startTime.pings.filter((ping) => ping.med_response_time);
                const med = working.length
                    ? Math.round(working.reduce((acc, ping) => acc + ping.med_response_time, 0) / working.length)
                    : null;
                const min = working.length
                    ? Math.round(working.reduce((acc, ping) => acc + ping.min_response_time, 0) / working.length)
                    : null;
                const max = working.length
                    ? Math.round(working.reduce((acc, ping) => acc + ping.max_response_time, 0) / working.length)
                    : null;
                const lost = startTime.pings.reduce((acc, ping) => acc + (ping.lost ?? 0), 0) || null;

                inserts.push([
                    service.id,
                    config.checkerId,
                    startTime.startTime,
                    aggregation.duration,
                    checks,
                    downs,
                    med,
                    min,
                    max,
                    lost
                ]);
            }
        }

        try {
            while (inserts.length) {
                const list = inserts.splice(0, 1000);
                await database.query(
                    "INSERT INTO services_smokeping (service_id, checker_id, start_time, duration, checks, downs, med_response_time, min_response_time, max_response_time, lost) VALUES " +
                        list.map(() => "(?)").join(", ") +
                        " ON DUPLICATE KEY UPDATE service_id=service_id",
                    list
                );
            }
            await database.query("DELETE FROM services_smokeping WHERE checker_id=? AND start_time<? AND duration=?", [
                config.checkerId,
                startTime,
                prevAggregation.duration
            ]);
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
            aggregating = false;
            return;
        }
    }

    console.log("Aggregated smokeping data.");
    aggregating = false;
};

/**
 * @param {import("mysql2/promise").Pool} database
 * @param {number[]} servicesId
 * @return {Promise<{ service: number; online: boolean }[]>}
 */
const getServicesStates = async (database, servicesId) => {
    let subsql = "SELECT service_id, checker_id, MAX(start_time) AS start_time";
    subsql += " FROM services_smokeping";
    subsql += " WHERE service_id IN (?) AND checker_id=?";
    subsql += " GROUP BY service_id";

    let sql = "SELECT services_smokeping.service_id, services_smokeping.downs";
    sql += " FROM services_smokeping";
    sql += " JOIN (" + subsql + ") latest";
    sql += " ON services_smokeping.checker_id=latest.checker_id AND services_smokeping.service_id=latest.service_id";
    sql += " AND services_smokeping.start_time=latest.start_time";

    let lastPings;
    try {
        [lastPings] = await database.query(sql, [servicesId, config.checkerId]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        throw new Error("Database error");
    }

    return lastPings.map((lastPing) => ({ service: lastPing.service_id, online: !lastPing.downs }));
};
