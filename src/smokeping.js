const { getConfig } = require("raraph84-lib");
const { median } = require("./utils");
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
    await aggregate(database);

    smokepingInterval = setInterval(() => smokeping(database), 2000);
    aggregateInterval = setInterval(() => aggregate(database), 10 * 60 * 1000);
};

module.exports.stop = async () => {
    clearInterval(smokepingInterval);
    clearInterval(aggregateInterval);
};

/** @type {{ time: number; id: string; latency: number | null; error: any | null; }[]} */
let pings = [];
/** @type {{ id: string; ip: string; }[]} */
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
const smokeping = async (database) => {
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
                service,
                time,
                pings: servicePings.map((ping) => ({ latency: ping.latency, error: ping.error }))
            });
        }
    }

    if (checks.length) {
        const inserts = [];
        for (const check of checks) {
            const latencies = check.pings.filter((ping) => ping.latency).map((ping) => ping.latency);
            const med = latencies.length ? median(latencies) : null;
            const min = latencies.length ? Math.min(...latencies) : null;
            const max = latencies.length ? Math.max(...latencies) : null;
            const lost = check.pings.length - latencies.length || null;
            const downs = latencies.length === 0 ? 1 : null;

            inserts.push([check.service, config.checkerId, check.time, 1, 5, lost, med, min, max, downs]);
        }

        let failed = false;
        try {
            await database.query(
                "INSERT INTO services_smokeping (service_id, checker_id, start_time, duration, sent, lost, med_response_time, min_response_time, max_response_time, downs) VALUES " +
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
                        "INSERT INTO services_smokeping (service_id, checker_id, start_time, duration, sent, lost, med_response_time, min_response_time, max_response_time, downs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        insert
                    );
                } catch (error) {
                    console.log(`SQL Error - ${__filename} - ${error}`);
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
        if (old) old.ip = service.ip;
        else smokepingServices.push({ id: service.service_id, ip: service.ip });
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
                const sent = startTime.pings.reduce((acc, ping) => acc + ping.sent, 0);
                const lost = startTime.pings.reduce((acc, ping) => acc + (ping.lost ?? 0), 0) || null;
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
                const downs = startTime.pings.reduce((acc, ping) => acc + (ping.downs ?? 0), 0) || null;

                inserts.push([
                    service.id,
                    config.checkerId,
                    startTime.startTime,
                    aggregation.duration,
                    sent,
                    lost,
                    med,
                    min,
                    max,
                    downs
                ]);
            }
        }

        try {
            while (inserts.length) {
                const list = inserts.splice(0, 1000);
                await database.query(
                    "INSERT INTO services_smokeping (service_id, checker_id, start_time, duration, sent, lost, med_response_time, min_response_time, max_response_time, downs) VALUES " +
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
            return;
        }
    }

    console.log("Aggregated smokeping data.");
    aggregating = false;
};
