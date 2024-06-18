const { promises: dns } = require("dns");
const { isIP } = require("net");
const { createPool } = require("mysql2/promise");
const { getConfig, TaskManager } = require("raraph84-lib");
const { checkServer, checkWebsite, checkMinecraft, checkApi, checkWs, checkBot } = require("./checkers");
const pLimit = require("p-limit");
const config = getConfig(__dirname);

require("dotenv").config({ path: [".env.local", ".env"] });

const tasks = new TaskManager();

const database = createPool({ password: process.env.DATABASE_PASSWORD, charset: "utf8mb4_general_ci", ...config.database });
tasks.addTask(async (resolve, reject) => {
    console.log("Connexion à la base de données...");
    try {
        await database.query("SELECT 1");
    } catch (error) {
        console.log("Impossible de se connecter à la base de données - " + error);
        reject();
        return;
    }
    console.log("Connecté à la base de données !");
    resolve();
}, (resolve) => database.end().then(() => resolve()));

let checkerInterval;
tasks.addTask((resolve) => {
    checkServices();
    checkerInterval = setInterval(() => checkServices(), 60 * 1000);
    resolve();
}, (resolve) => { clearInterval(checkerInterval); resolve(); });

tasks.run();

const checkServices = async () => {

    console.log("Vérification des statuts des services...");

    const currentDate = Date.now();
    const currentMinute = Math.floor(currentDate / 1000 / 60);

    let services;
    try {
        [services] = await database.query("SELECT * FROM services WHERE !disabled");
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    const servers = [];
    const checks = [];

    for (const service of services) {
        let domain;
        if (service.type === "server") domain = service.host;
        else if (service.type === "minecraft") domain = service.host.split(/:/)[0];
        else domain = service.host.split(/:\/\/|:|\//)[1];
        let serverIp;
        if (isIP(domain)) serverIp = domain;
        else {
            try {
                serverIp = (await dns.lookup(domain)).address;
            } catch (error) {
                checks.push({ serviceId: service.service_id, online: false, error });
                continue;
            }
        }
        const server = servers.find((server) => server.ip === serverIp);
        if (!server) servers.push({ ip: serverIp, services: [service], ping: null });
        else server.services.push(service);
    }

    await Promise.all(servers.filter((server) => server.services.some((service) => service.type === "server")).map(async (server) => {

        let responseTime = null;
        try {
            responseTime = await checkServer(server.ip);
        } catch (error) {
            server.ping = { online: false, responseTime, error };
            return;
        }

        server.ping = { online: true, responseTime, error: null };
    }));

    for (const server of servers) {

        const limit = pLimit(Math.max(5, Math.ceil(10 * server.services.length / 60)));

        checks.push(...await Promise.all(server.services.map((service) => limit(async () => {

            if (service.type === "server")
                return { serviceId: service.service_id, online: server.ping.online, responseTime: server.ping.responseTime, error: server.ping.error };

            //if (server.ping && !server.ping.online)
            //    return { serviceId: service.service_id, online: false, error: server.ping.error };

            let responseTime = null;
            try {
                if (service.type === "website") responseTime = await checkWebsite(service.host);
                else if (service.type === "minecraft") responseTime = await checkMinecraft(service.host);
                else if (service.type === "api") responseTime = await checkApi(service.host);
                else if (service.type === "gateway") responseTime = await checkWs(service.host);
                else if (service.type === "bot") await checkBot(service.host);
            } catch (error) {
                return { serviceId: service.service_id, online: false, error };
            }

            return { serviceId: service.service_id, online: true, responseTime };
        }))));
    }

    checks.filter((check) => check.error).forEach((check) => check.error = check.error instanceof AggregateError ? check.error.errors.map((error) => error.toString()).join(" - ") : check.error.toString());

    const onlineAlerts = [];
    const offlineAlerts = [];
    const stillDown = [];

    for (const service of services) {

        const check = checks.find((check) => check.serviceId === service.service_id);

        if (check.online) {
            const alreadyOnline = await serviceOnline(service, check.responseTime, currentDate);
            if (!alreadyOnline) onlineAlerts.push(service);
        } else {
            const alreadyOffline = await serviceOffline(service, currentDate);
            if (!alreadyOffline) offlineAlerts.push({ ...service, error: check.error });
            stillDown.push(service);
        }
    }

    if (offlineAlerts.length > 0) {
        await alert({
            title: `Service${offlineAlerts.length > 1 ? "s" : ""} Hors Ligne`,
            description: offlineAlerts.map((service) => `:warning: **Le service **\`${service.name}\`** est hors ligne.**\n${service.error}`).join("\n"),
            timestamp: new Date(currentMinute * 1000 * 60),
            color: "16711680"
        });
    }

    if (onlineAlerts.length > 0) {
        await alert({
            title: `Service${onlineAlerts.length > 1 ? "s" : ""} En Ligne`,
            description: [
                ...onlineAlerts.map((service) => `:warning: **Le service **\`${service.name}\`** est de nouveau en ligne.**`),
                ...(stillDown.length > 0 ? ["**Les services toujours hors ligne sont : " + stillDown.map((service) => `**\`${service.name}\`**`).join(", ") + ".**"] : [])
            ].join("\n"),
            timestamp: new Date(currentMinute * 1000 * 60),
            color: "65280"
        });
    }

    console.log("Vérification des statuts des services terminée !");
};

const getLastStatus = async (service) => {

    let lastEvent;
    try {
        [lastEvent] = await database.query("SELECT * FROM services_events WHERE service_id=? ORDER BY minute DESC LIMIT 1", [service.service_id]);
        lastEvent = lastEvent[0];
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }

    return !!lastEvent?.online || false;
};

const serviceOnline = async (service, responseTime, currentDate) => {

    const currentMinute = Math.floor(currentDate / 1000 / 60);

    const alreadyOnline = await getLastStatus(service);

    if (!alreadyOnline) {

        try {
            await database.query("INSERT INTO services_events (service_id, minute, online) VALUES (?, ?, 1)", [service.service_id, currentMinute]);
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }
    }

    try {
        await database.query("INSERT INTO services_statuses (service_id, minute, online, response_time) VALUES (?, ?, 1, ?)", [service.service_id, currentMinute, responseTime]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }

    await updateDailyStatuses(service, currentDate);

    return alreadyOnline;
};

const serviceOffline = async (service, currentDate) => {

    const currentMinute = Math.floor(currentDate / 1000 / 60);

    const alreadyOffline = !await getLastStatus(service);

    if (!alreadyOffline) {

        try {
            await database.query("INSERT INTO services_events (service_id, minute, online) VALUES (?, ?, 0)", [service.service_id, currentMinute]);
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }
    }

    try {
        await database.query("INSERT INTO services_statuses (service_id, minute, online) VALUES (?, ?, 0)", [service.service_id, currentMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }

    await updateDailyStatuses(service, currentDate);

    return alreadyOffline;
};

const updateDailyStatuses = async (service, currentDate) => {

    const day = Math.floor(currentDate / 1000 / 60 / 60 / 24) - 1;
    const firstMinute = day * 24 * 60;
    const lastMinute = firstMinute + 24 * 60;

    let lastDailyStatus;
    try {
        [lastDailyStatus] = await database.query("SELECT * FROM services_daily_statuses WHERE service_id=? ORDER BY day DESC LIMIT 1", [service.service_id]);
        lastDailyStatus = lastDailyStatus[0];
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    if (lastDailyStatus?.day === day)
        return;

    let statuses;
    try {
        [statuses] = await database.query("SELECT * FROM services_statuses WHERE service_id=? && minute>=? && minute<?", [service.service_id, firstMinute, lastMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    const onlineStatuses = statuses.filter((status) => status.online);
    const uptime = statuses.length > 0 ? Math.round(onlineStatuses.length / statuses.length * 100 * 100) / 100 : null;
    const responseTime = onlineStatuses.length > 0 ? Math.round(onlineStatuses.reduce((acc, status) => acc + status.response_time, 0) / onlineStatuses.length) : null;

    try {
        await database.query("INSERT INTO services_daily_statuses (service_id, day, statuses_amount, uptime, response_time) VALUES (?, ?, ?, ?, ?)", [service.service_id, day, statuses.length, uptime, responseTime]);
        await database.query("DELETE FROM services_statuses WHERE service_id=? && minute>=? && minute<?", [service.service_id, firstMinute, lastMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }
};

const alert = (embed) => fetch(process.env.ALERT_DISCORD_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "@everyone", embeds: [embed] }) });
