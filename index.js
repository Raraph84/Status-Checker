const { promises: dns } = require("dns");
const { createPool } = require("mysql2/promise");
const { getConfig, TaskManager } = require("raraph84-lib");
const { checkWebsite, checkMinecraft, checkApi, checkWs, checkBot } = require("./checkers");
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
    checkerInterval = setInterval(() => checkNodes(), 60 * 1000);
    resolve();
}, (resolve) => { clearInterval(checkerInterval); resolve(); });

tasks.run();

const checkNodes = async () => {

    console.log("Vérification des statuts des services...");

    const onlineAlerts = [];
    const offlineAlerts = [];
    const stillDown = [];
    const currentDate = Date.now();
    const currentMinute = Math.floor(currentDate / 1000 / 60);

    let nodes;
    try {
        [nodes] = await database.query("SELECT * FROM Nodes WHERE !Disabled");
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    const servers = [];
    const checks = [];

    for (const node of nodes) {
        const domain = node.Type !== "minecraft" ? node.Host.split(/:\/\/|:|\//)[1] : node.Host.split(/:/)[0];
        let serverIp;
        try {
            serverIp = (await dns.lookup(domain)).address;
        } catch (error) {
            checks.push({ nodeId: node.Node_ID, online: false, error: error.toString() });
            continue;
        }
        const server = servers.find((server) => server.ip === serverIp);
        if (!server) servers.push({ ip: serverIp, nodes: [node] });
        else server.nodes.push(node);
    }

    for (const server of servers) {

        const limit = pLimit(Math.max(5, Math.ceil(10 * server.nodes.length / 60)));

        const serverChecks = await Promise.all(server.nodes.map((node) => limit(async () => {

            let responseTime;
            try {
                if (node.Type === "website") responseTime = await checkWebsite(node.Host);
                else if (node.Type === "minecraft") responseTime = await checkMinecraft(node.Host);
                else if (node.Type === "api") responseTime = await checkApi(node.Host);
                else if (node.Type === "gateway") responseTime = await checkWs(node.Host);
                else if (node.Type === "bot") await checkBot(node.Host);
            } catch (error) {
                return { nodeId: node.Node_ID, online: false, error: error instanceof AggregateError ? error.errors.map((error) => error.toString()).join(" - ") : error.toString() };
            }

            return { nodeId: node.Node_ID, online: true, responseTime };
        })));

        checks.push(...serverChecks);
    }

    for (const node of nodes) {

        const check = checks.find((check) => check.nodeId === node.Node_ID);

        if (check.online) {
            const alreadyOnline = await nodeOnline(node, node.Type !== "bot" ? check.responseTime : -1, currentDate);
            if (!alreadyOnline) onlineAlerts.push(node);
        } else {
            const alreadyOffline = await nodeOffline(node, currentDate);
            if (!alreadyOffline) offlineAlerts.push({ ...node, error: check.error });
            stillDown.push(node);
        }
    }

    if (offlineAlerts.length > 0) {
        await alert({
            title: `Service${offlineAlerts.length > 1 ? "s" : ""} Hors Ligne`,
            description: offlineAlerts.map((node) => `:warning: **Le service **\`${node.Name}\`** est hors ligne.**\n${node.error}`).join("\n"),
            timestamp: new Date(currentMinute * 1000 * 60),
            color: "16711680"
        });
    }

    if (onlineAlerts.length > 0) {
        await alert({
            title: `Service${onlineAlerts.length > 1 ? "s" : ""} En Ligne`,
            description: [
                ...onlineAlerts.map((node) => `:warning: **Le service **\`${node.Name}\`** est de nouveau en ligne.**`),
                ...(stillDown.length > 0 ? ["**Les services toujours hors ligne sont : " + stillDown.map((node) => `**\`${node.Name}\`**`).join(", ") + ".**"] : [])
            ].join("\n"),
            timestamp: new Date(currentMinute * 1000 * 60),
            color: "65280"
        });
    }

    console.log("Vérification des statuts des services terminée !");
};

const getLastStatus = async (node) => {

    let lastEvent;
    try {
        [lastEvent] = await database.query("SELECT * FROM services_events WHERE service_id=? ORDER BY minute DESC LIMIT 1", [node.Node_ID]);
        lastEvent = lastEvent[0];
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }

    return !!lastEvent?.online || false;
};

const nodeOnline = async (node, responseTime, currentDate) => {

    const currentMinute = Math.floor(currentDate / 1000 / 60);

    const alreadyOnline = await getLastStatus(node);

    if (!alreadyOnline) {

        try {
            await database.query("INSERT INTO services_events (service_id, minute, online) VALUES (?, ?, 1)", [node.Node_ID, currentMinute]);
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }
    }

    try {
        await database.query("INSERT INTO services_statuses (service_id, minute, online, response_time) VALUES (?, ?, 1, ?)", [node.Node_ID, currentMinute, responseTime >= 0 ? responseTime : null]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }

    await updateDailyStatuses(node, currentDate);

    return alreadyOnline;
};

const nodeOffline = async (node, currentDate) => {

    const currentMinute = Math.floor(currentDate / 1000 / 60);

    const alreadyOffline = !await getLastStatus(node);

    if (!alreadyOffline) {

        try {
            await database.query("INSERT INTO services_events (service_id, minute, online) VALUES (?, ?, 0)", [node.Node_ID, currentMinute]);
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }
    }

    try {
        await database.query("INSERT INTO services_statuses (service_id, minute, online) VALUES (?, ?, 0)", [node.Node_ID, currentMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }

    await updateDailyStatuses(node, currentDate);

    return alreadyOffline;
};

const updateDailyStatuses = async (node, currentDate) => {

    const day = Math.floor(currentDate / 1000 / 60 / 60 / 24) - 1;
    const firstMinute = day * 24 * 60;
    const lastMinute = firstMinute + 24 * 60;

    let lastDailyStatus;
    try {
        [lastDailyStatus] = await database.query("SELECT * FROM services_daily_statuses WHERE service_id=? ORDER BY day DESC LIMIT 1", [node.Node_ID]);
        lastDailyStatus = lastDailyStatus[0];
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    if (lastDailyStatus?.day === day)
        return;

    let statuses;
    try {
        [statuses] = await database.query("SELECT * FROM services_statuses WHERE service_id=? && minute>=? && minute<?", [node.Node_ID, firstMinute, lastMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    const onlineStatuses = statuses.filter((status) => status.online);
    const uptime = statuses.length > 0 ? Math.round(onlineStatuses.length / statuses.length * 100 * 100) / 100 : null;
    const responseTime = onlineStatuses.length > 0 ? Math.round(onlineStatuses.reduce((acc, status) => acc + status.response_time, 0) / onlineStatuses.length) : null;

    try {
        await database.query("INSERT INTO services_daily_statuses (service_id, day, statuses_amount, uptime, response_time) VALUES (?, ?, ?, ?, ?)", [node.Node_ID, day, statuses.length, uptime, responseTime]);
        await database.query("DELETE FROM services_statuses WHERE service_id=? && minute>=? && minute<?", [node.Node_ID, firstMinute, lastMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }
};

const alert = (embed) => fetch(process.env.ALERT_DISCORD_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "@everyone", embeds: [embed] }) });
