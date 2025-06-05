const { getConfig } = require("raraph84-lib");
const { checkWebsite, checkMinecraft, checkApi, checkWs } = require("./checkers");
const { limits, alert, splitEmbed } = require("./utils");
const config = getConfig(__dirname + "/..");

let checkInterval = null;

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

    let lastMinute = -1;
    checkInterval = setInterval(() => {
        const date = new Date();
        if (date.getMinutes() === lastMinute || date.getSeconds() !== checker.check_second) return;
        lastMinute = date.getMinutes();
        checkServices(database, checker);
    }, 500);
};

module.exports.stop = async () => {
    clearInterval(checkInterval);
};

const checkServices = async (database, checker) => {
    console.log("Checking services statuses...");

    const currentDate = Date.now();
    const currentMinute = Math.floor(currentDate / 1000 / 60);

    const services = require("./services")
        .getServices()
        .filter((service) => service.type !== "server");

    const servers = [];
    const checks = [];

    for (const service of services) {
        if (!service.ip) {
            checks.push({ serviceId: service.service_id, online: false, error: service.error });
            continue;
        }

        const server = servers.find(
            (server) => (server.ipv4 && server.ipv4 === service.ipv4) || (server.ipv6 && server.ipv6 === service.ipv6)
        );
        if (!server) servers.push({ ipv4: service.ipv4, ipv6: service.ipv6, services: [service] });
        else {
            if (!server.ipv4) server.ipv4 = service.ipv4;
            if (!server.ipv6) server.ipv6 = service.ipv6;
            server.services.push(service);
        }
    }

    await Promise.all(
        servers.map(async (server) => {
            const limit = limits(5);
            await Promise.all(
                server.services.map((service, i) =>
                    limit(i * 100, async () => {
                        let responseTime = null;
                        try {
                            if (service.type === "website") responseTime = await checkWebsite(service.host);
                            else if (service.type === "minecraft") responseTime = await checkMinecraft(service.host);
                            else if (service.type === "api") responseTime = await checkApi(service.host);
                            else if (service.type === "gateway") responseTime = await checkWs(service.host);
                        } catch (error) {
                            checks.push({ serviceId: service.service_id, online: false, error });
                            return;
                        }

                        responseTime = responseTime ? Math.round(responseTime * 10) / 10 : responseTime;

                        checks.push({ serviceId: service.service_id, online: true, responseTime });
                    })
                )
            );
        })
    );

    checks
        .filter((check) => check.error)
        .forEach(
            (check) =>
                (check.error =
                    check.error instanceof AggregateError
                        ? check.error.errors.map((error) => error.toString()).join(" - ")
                        : check.error.toString())
        );

    const onlineAlerts = [];
    const offlineAlerts = [];
    const stillDown = [];

    for (const service of services) {
        const check = checks.find((check) => check.serviceId === service.service_id);
        if (!check) throw new Error("Service " + service.service_id + " not checked.");

        if (check.online) {
            const alreadyOnline = await serviceOnline(database, service, check.responseTime, currentMinute);
            if (!alreadyOnline) onlineAlerts.push(service);
        } else {
            const alreadyOffline = await serviceOffline(database, service, currentMinute);
            if (!alreadyOffline) offlineAlerts.push({ ...service, error: check.error });
            if (!service.disabled) stillDown.push(service);
        }

        await updateDailyStatuses(database, service, currentDate);
    }

    const checkDuration = (Date.now() - currentDate) / 1000;

    if (offlineAlerts.length > 0) {
        const everyone = offlineAlerts.some((service) => service.alert) ? "@everyone " : "";
        const embeds = splitEmbed({
            title: `Services hors ligne pour ${checker.name} ${checker.location}`,
            description: offlineAlerts
                .map((service) => `:warning: **Le service **\`${service.name}\`** est hors ligne.**\n${service.error}`)
                .join("\n"),
            footer: { text: "Services vérifiés en " + checkDuration.toFixed(1) + "s" },
            timestamp: new Date(currentMinute * 1000 * 60),
            color: (0xff0000).toString()
        });
        try {
            await alert({
                content: `${everyone}**${offlineAlerts.length} Service${offlineAlerts.length > 1 ? "s" : ""} hors ligne** pour ${checker.name} ${checker.location}`
            });
            for (const embed of embeds) await alert({ embeds: [embed] });
        } catch (error) {
            console.log("Cannot send alert - " + error);
        }
    }

    if (onlineAlerts.length > 0) {
        const everyone = onlineAlerts.some((service) => service.alert) ? "@everyone " : "";
        const embeds = splitEmbed({
            title: `Services en ligne pour ${checker.name} ${checker.location}`,
            description: [
                ...onlineAlerts.map(
                    (service) => `:warning: **Le service **\`${service.name}\`** est de nouveau en ligne.**`
                ),
                ...(stillDown.length > 0
                    ? [
                          "**Les services toujours hors ligne sont : " +
                              stillDown.map((service) => `**\`${service.name}\`**`).join(", ") +
                              ".**"
                      ]
                    : [])
            ].join("\n"),
            footer: { text: "Services vérifiés en " + checkDuration.toFixed(1) + "s" },
            timestamp: new Date(currentMinute * 1000 * 60),
            color: (0x00ff00).toString()
        });
        try {
            await alert({
                content: `${everyone}**${onlineAlerts.length} Service${onlineAlerts.length > 1 ? "s" : ""} en ligne** pour ${checker.name} ${checker.location}`
            });
            for (const embed of embeds) await alert({ embeds: [embed] });
        } catch (error) {
            console.log("Cannot send alert - " + error);
        }
    }

    console.log("Services statuses checked in " + checkDuration.toFixed(1) + "s.");
};

const getLastStatus = async (database, service) => {
    let lastEvent;
    try {
        lastEvent = (
            await database.query(
                "SELECT * FROM services_events WHERE service_id=? && checker_id=? ORDER BY minute DESC LIMIT 1",
                [service.service_id, config.checkerId]
            )
        )[0][0];
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }

    return !!lastEvent?.online || false;
};

const serviceOnline = async (database, service, responseTime, currentMinute) => {
    const alreadyOnline = await getLastStatus(database, service);

    if (!alreadyOnline) {
        try {
            await database.query(
                "INSERT INTO services_events (service_id, checker_id, minute, online) VALUES (?, ?, ?, 1)",
                [service.service_id, config.checkerId, currentMinute]
            );
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }
    }

    if (!service.disabled) {
        try {
            await database.query(
                "INSERT INTO services_statuses (service_id, checker_id, minute, online, response_time) VALUES (?, ?, ?, 1, ?)",
                [service.service_id, config.checkerId, currentMinute, responseTime]
            );
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }
    }

    return alreadyOnline;
};

const serviceOffline = async (database, service, currentMinute) => {
    const alreadyOffline = !(await getLastStatus(database, service));

    if (!alreadyOffline) {
        try {
            await database.query(
                "INSERT INTO services_events (service_id, checker_id, minute, online) VALUES (?, ?, ?, 0)",
                [service.service_id, config.checkerId, currentMinute]
            );
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }
    }

    if (!service.disabled) {
        try {
            await database.query(
                "INSERT INTO services_statuses (service_id, checker_id, minute, online) VALUES (?, ?, ?, 0)",
                [service.service_id, config.checkerId, currentMinute]
            );
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }
    }

    return alreadyOffline;
};

const updateDailyStatuses = async (database, service, currentDate) => {
    const day = Math.floor(currentDate / 1000 / 60 / 60 / 24) - 1;
    const firstMinute = day * 24 * 60;
    const lastMinute = firstMinute + 24 * 60;

    let lastDailyStatus;
    try {
        lastDailyStatus = (
            await database.query(
                "SELECT * FROM services_daily_statuses WHERE service_id=? && checker_id=? ORDER BY day DESC LIMIT 1",
                [service.service_id, config.checkerId]
            )
        )[0][0];
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    if (lastDailyStatus?.day === day) return;

    let statuses;
    try {
        [statuses] = await database.query(
            "SELECT * FROM services_statuses WHERE service_id=? && checker_id=? && minute>=? && minute<?",
            [service.service_id, config.checkerId, firstMinute, lastMinute]
        );
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    if (statuses.length === 0) return;

    const onlineStatuses = statuses.filter((status) => status.online);
    const uptime = Math.round((onlineStatuses.length / statuses.length) * 100 * 1000) / 1000;
    const responseTime =
        onlineStatuses.length > 0
            ? Math.round(
                  (onlineStatuses.reduce((acc, status) => acc + status.response_time, 0) / onlineStatuses.length) * 10
              ) / 10
            : null;

    try {
        await database.query(
            "INSERT INTO services_daily_statuses (service_id, checker_id, day, statuses_amount, uptime, response_time) VALUES (?, ?, ?, ?, ?, ?)",
            [service.service_id, config.checkerId, day, statuses.length, uptime, responseTime]
        );
        await database.query("DELETE FROM services_statuses WHERE service_id=? && checker_id=? && minute<?", [
            service.service_id,
            config.checkerId,
            firstMinute
        ]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }
};
