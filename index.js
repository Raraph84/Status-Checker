const { promises: dns } = require("dns");
const { isIP } = require("net");
const { createPool } = require("mysql2/promise");
const { getConfig, TaskManager } = require("raraph84-lib");
const { checkServer, checkWebsite, checkMinecraft, checkApi, checkWs, checkBot } = require("./src/checkers");
const { limits, alert, splitEmbed } = require("./src/utils");
const config = getConfig(__dirname);

require("dotenv").config({ path: [".env.local", ".env"] });

const tasks = new TaskManager();

const database = createPool({ password: process.env.DATABASE_PASSWORD, charset: "utf8mb4_general_ci", ...config.database });
tasks.addTask(async (resolve, reject) => {
    console.log("Connecting to the database...");
    try {
        await database.query("SELECT 1");
    } catch (error) {
        console.log("Cannot connect to the database - " + error);
        reject();
        return;
    }
    console.log("Connected to the database.");
    resolve();
}, (resolve) => database.end().then(() => resolve()));

let checker;
tasks.addTask(async (resolve, reject) => {
    try {
        checker = (await database.query("SELECT * FROM checkers WHERE checker_id=?", [config.checkerId]))[0][0];
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        reject();
        return;
    }
    if (!checker) {
        console.log("Checker does not exist.");
        reject();
        return;
    }
    resolve();
}, (resolve) => resolve());

let checkerInterval;
tasks.addTask((resolve) => {
    checkServices();
    checkerInterval = setInterval(() => checkServices(), 60 * 1000);
    resolve();
}, (resolve) => { clearInterval(checkerInterval); resolve(); });

tasks.run();

const checkServices = async () => {

    console.log(new Date(), "Checking services statuses...");

    const currentDate = Date.now();
    const currentMinute = Math.floor(currentDate / 1000 / 60);

    let services;
    try {
        [services] = await database.query("SELECT * FROM checkers_services INNER JOIN services ON services.service_id=checkers_services.service_id WHERE checker_id=?", [checker.checker_id]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    const servers = [];
    const checks = [];

    for (const service of services) {

        let host;
        if (service.type === "server") host = service.host;
        else if (service.type === "minecraft") host = service.host.split(/:/)[0];
        else host = service.host.split(/:\/\/|:|\//)[1];

        let serverIp;
        if (isIP(host)) serverIp = host;
        else {

            if (service.type === "minecraft") {
                let results;
                try {
                    results = await dns.resolveSrv("_minecraft._tcp." + host);
                } catch (error) {
                }
                if (results && results[0])
                    host = results[0].name;
            }

            try {
                serverIp = (await dns.lookup(host, { family: 4 })).address;
            } catch (error) {
                checks.push({ serviceId: service.service_id, online: false, error });
                continue;
            }
        }

        const server = servers.find((server) => server.ip === serverIp);
        if (!server) servers.push({ ip: serverIp, services: [service] });
        else server.services.push(service);
    }

    await Promise.all(servers.map(async (server) => {
        const limit = limits(5);
        await Promise.all(server.services.map((service, i) => limit(i * 100, async () => {

            let responseTime = null;
            try {
                if (service.type === "website") responseTime = await checkWebsite(service.host);
                else if (service.type === "minecraft") responseTime = await checkMinecraft(service.host);
                else if (service.type === "api") responseTime = await checkApi(service.host);
                else if (service.type === "gateway") responseTime = await checkWs(service.host);
                else if (service.type === "bot") await checkBot(service.host);
                else if (service.type === "server") responseTime = await checkServer(server.ip);
            } catch (error) {
                checks.push({ serviceId: service.service_id, online: false, error });
                return;
            }

            checks.push({ serviceId: service.service_id, online: true, responseTime });
        })));
    }));

    checks.filter((check) => check.error).forEach((check) => check.error = check.error instanceof AggregateError ? check.error.errors.map((error) => error.toString()).join(" - ") : check.error.toString());

    const onlineAlerts = [];
    const offlineAlerts = [];
    const stillDown = [];

    for (const service of services) {

        const check = checks.find((check) => check.serviceId === service.service_id);
        if (!check) throw new Error("Service " + service.service_id + " not checked.");

        if (check.online) {
            const alreadyOnline = await serviceOnline(service, check.responseTime, currentMinute);
            if (!alreadyOnline) onlineAlerts.push(service);
        } else {
            const alreadyOffline = await serviceOffline(service, currentMinute);
            if (!alreadyOffline) offlineAlerts.push({ ...service, error: check.error });
            if (!service.disabled) stillDown.push(service);
        }

        await updateDailyStatuses(service, currentDate);
    }

    const checkDuration = (Date.now() - currentDate) / 1000;

    if (offlineAlerts.length > 0) {
        const embeds = splitEmbed({
            title: `Services Hors Ligne pour ${checker.name} ${checker.location}`,
            description: offlineAlerts.map((service) => `:warning: **Le service **\`${service.name}\`** est hors ligne.**\n${service.error}`).join("\n"),
            footer: { text: "Services vérifiés en " + checkDuration.toFixed(1) + "s" },
            timestamp: new Date(currentMinute * 1000 * 60),
            color: 0xFF0000.toString()
        });
        try {
            await alert({ content: `@everyone **${offlineAlerts.length} Services hors ligne** pour ${checker.name} ${checker.location}` });
            for (const embed of embeds) await alert({ embeds: [embed] });
        } catch (error) {
            console.log("Cannot send alert - " + error);
        }
    }

    if (onlineAlerts.length > 0) {
        const embeds = splitEmbed({
            title: `Services En Ligne pour ${checker.name} ${checker.location}`,
            description: [
                ...onlineAlerts.map((service) => `:warning: **Le service **\`${service.name}\`** est de nouveau en ligne.**`),
                ...(stillDown.length > 0 ? ["**Les services toujours hors ligne sont : " + stillDown.map((service) => `**\`${service.name}\`**`).join(", ") + ".**"] : [])
            ].join("\n"),
            footer: { text: "Services vérifiés en " + checkDuration.toFixed(1) + "s" },
            timestamp: new Date(currentMinute * 1000 * 60),
            color: 0x00FF00.toString()
        });
        try {
            await alert({ content: `@everyone **${onlineAlerts.length} Services en ligne** pour ${checker.name} ${checker.location}` });
            for (const embed of embeds) await alert({ embeds: [embed] });
        } catch (error) {
            console.log("Cannot send alert - " + error);
        }
    }

    console.log(new Date(), "Services statuses checked in " + checkDuration.toFixed(1) + "s.");
};

const getLastStatus = async (service) => {

    let lastEvent;
    try {
        lastEvent = (await database.query("SELECT * FROM services_events WHERE service_id=? && checker_id=? ORDER BY minute DESC LIMIT 1", [service.service_id, checker.checker_id]))[0][0];
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }

    return !!lastEvent?.online || false;
};

const serviceOnline = async (service, responseTime, currentMinute) => {

    const alreadyOnline = await getLastStatus(service);

    if (!alreadyOnline) {
        try {
            await database.query("INSERT INTO services_events (service_id, checker_id, minute, online) VALUES (?, ?, ?, 1)", [service.service_id, checker.checker_id, currentMinute]);
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }
    }

    if (!service.disabled) {
        try {
            await database.query("INSERT INTO services_statuses (service_id, checker_id, minute, online, response_time) VALUES (?, ?, ?, 1, ?)", [service.service_id, checker.checker_id, currentMinute, responseTime]);
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }
    }

    return alreadyOnline;
};

const serviceOffline = async (service, currentMinute) => {

    const alreadyOffline = !await getLastStatus(service);

    if (!alreadyOffline) {
        try {
            await database.query("INSERT INTO services_events (service_id, checker_id, minute, online) VALUES (?, ?, ?, 0)", [service.service_id, checker.checker_id, currentMinute]);
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }
    }

    if (!service.disabled) {
        try {
            await database.query("INSERT INTO services_statuses (service_id, checker_id, minute, online) VALUES (?, ?, ?, 0)", [service.service_id, checker.checker_id, currentMinute]);
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }
    }

    return alreadyOffline;
};

const updateDailyStatuses = async (service, currentDate) => {

    const day = Math.floor(currentDate / 1000 / 60 / 60 / 24) - 1;
    const firstMinute = day * 24 * 60;
    const lastMinute = firstMinute + 24 * 60;

    let lastDailyStatus;
    try {
        lastDailyStatus = (await database.query("SELECT * FROM services_daily_statuses WHERE service_id=? && checker_id=? ORDER BY day DESC LIMIT 1", [service.service_id, checker.checker_id]))[0][0];
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    if (lastDailyStatus?.day === day)
        return;

    let statuses;
    try {
        [statuses] = await database.query("SELECT * FROM services_statuses WHERE service_id=? && checker_id=? && minute>=? && minute<?", [service.service_id, checker.checker_id, firstMinute, lastMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    if (statuses.length === 0)
        return;

    const onlineStatuses = statuses.filter((status) => status.online);
    const uptime = Math.round(onlineStatuses.length / statuses.length * 100 * 1000) / 1000;
    const responseTime = onlineStatuses.length > 0 ? Math.round(onlineStatuses.reduce((acc, status) => acc + status.response_time, 0) / onlineStatuses.length) : null;

    try {
        await database.query("INSERT INTO services_daily_statuses (service_id, checker_id, day, statuses_amount, uptime, response_time) VALUES (?, ?, ?, ?, ?, ?)", [service.service_id, checker.checker_id, day, statuses.length, uptime, responseTime]);
        await database.query("DELETE FROM services_statuses WHERE service_id=? && checker_id=? && minute<?", [service.service_id, checker.checker_id, lastMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }
};
