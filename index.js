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
    for (const node of nodes) {
        const serverIp = (await dns.lookup(node.Type !== "minecraft" ? node.Host.split(/:\/\/|:|\//)[1] : node.Host.split(/:/)[0])).address;
        const server = servers.find((server) => server.ip === serverIp);
        if (!server) servers.push({ ip: serverIp, nodes: [node] });
        else server.nodes.push(node);
    }

    const checks = [];
    for (const server of servers) {

        const limit = pLimit(5);

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
            if (alreadyOffline) offlineAlerts.push({ ...node, error: check.error });
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

        let stillDown;
        try {
            [stillDown] = await database.query("SELECT Nodes.* FROM Nodes_Events INNER JOIN Nodes ON Nodes.Node_ID=Nodes_Events.Node_ID WHERE (Nodes_Events.Node_ID, Minute) IN (SELECT Node_ID, MAX(Minute) AS Minute FROM Nodes_Events GROUP BY Node_ID) && Online=0 && Disabled=0");
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
            return;
        }

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
}

const getLastStatus = async (node) => {

    let lastStatus;
    try {
        [lastStatus] = await database.query("SELECT * FROM Nodes_Events WHERE Node_ID=? ORDER BY Minute DESC LIMIT 1", [node.Node_ID]);
        lastStatus = lastStatus[0];
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }

    return lastStatus ? !!lastStatus.Online : false;
}

const nodeOnline = async (node, responseTime, currentDate) => {

    const currentMinute = Math.floor(currentDate / 1000 / 60);

    if (!await getLastStatus(node)) {

        try {
            await database.query("INSERT INTO Nodes_Events VALUES (?, ?, 1)", [node.Node_ID, currentMinute]);
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }

        return false;
    }

    try {
        await database.query("INSERT INTO Nodes_Statuses VALUES (?, ?, 1)", [node.Node_ID, currentMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }

    if (responseTime >= 0) {
        try {
            await database.query("INSERT INTO Nodes_Response_Times VALUES (?, ?, ?)", [node.Node_ID, currentMinute, responseTime]);
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }
    }

    await updateDailyUptime(node, currentDate);
    await updateDailyResponseTime(node);

    return true;
}

const nodeOffline = async (node, currentDate) => {

    const currentMinute = Math.floor(currentDate / 1000 / 60);

    if (await getLastStatus(node)) {

        try {
            await database.query("INSERT INTO Nodes_Events VALUES (?, ?, 0)", [node.Node_ID, currentMinute]);
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }

        return false;
    }

    try {
        await database.query("INSERT INTO Nodes_Statuses VALUES (?, ?, 0)", [node.Node_ID, currentMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }

    await updateDailyUptime(node, currentDate);
    await updateDailyResponseTime(node);

    return true;
}

const updateDailyUptime = async (node, currentDate) => {

    const day = Math.floor(currentDate / 1000 / 60 / 60 / 24) - 1;
    const firstMinute = day * 24 * 60;

    let lastDailyUptime;
    try {
        [lastDailyUptime] = await database.query("SELECT * FROM Nodes_Daily_Uptimes WHERE Node_ID=? ORDER BY Day DESC LIMIT 1", [node.Node_ID]);
        lastDailyUptime = lastDailyUptime[0];
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    if (lastDailyUptime && lastDailyUptime.Day === day)
        return;

    let statuses;
    try {
        [statuses] = await database.query("SELECT Minute, Online FROM Nodes_Statuses WHERE Node_ID=? && Minute>=?", [node.Node_ID, firstMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    const totalStatuses = [];
    for (let minute = firstMinute; minute < firstMinute + 24 * 60; minute++) {
        const status = statuses.find((status) => status.Minute === minute);
        if (!status) continue;
        totalStatuses.push(status.Online);
    }

    if (totalStatuses.length < 1) return;

    const uptime = Math.round(totalStatuses.reduce((acc, status) => status ? acc + 1 : acc, 0) / totalStatuses.length * 100 * 100) / 100;

    try {
        await database.query("INSERT INTO Nodes_Daily_Uptimes VALUES (?, ?, ?)", [node.Node_ID, day, uptime]);
        await database.query("DELETE FROM Nodes_Statuses WHERE Node_ID=? && Minute<?", [node.Node_ID, firstMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }
}

const updateDailyResponseTime = async (node, currentDate) => {

    const day = Math.floor(currentDate / 1000 / 60 / 60 / 24) - 1;
    const firstMinute = day * 24 * 60;

    let lastDailyResponseTime;
    try {
        [lastDailyResponseTime] = await database.query("SELECT * FROM Nodes_Daily_Response_Times WHERE Node_ID=? ORDER BY Day DESC LIMIT 1", [node.Node_ID]);
        lastDailyResponseTime = lastDailyResponseTime[0];
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    if (lastDailyResponseTime && lastDailyResponseTime.Day === day)
        return;

    let responseTimes;
    try {
        [responseTimes] = await database.query("SELECT Minute, Response_Time FROM Nodes_Response_Times WHERE Node_ID=? && Minute>=?", [node.Node_ID, firstMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    const totalResponseTimes = [];
    for (let minute = firstMinute; minute < firstMinute + 24 * 60; minute++) {
        const responseTime = responseTimes.find((responseTime) => responseTime.Minute === minute);
        if (!responseTime) continue;
        totalResponseTimes.push(responseTime.Response_Time);
    }

    if (totalResponseTimes.length < 1) return;

    const averageResponseTime = Math.round(totalResponseTimes.reduce((acc, responseTime) => acc + responseTime, 0) / totalResponseTimes.length);

    try {
        await database.query("INSERT INTO Nodes_Daily_Response_Times VALUES (?, ?, ?)", [node.Node_ID, day, averageResponseTime]);
        await database.query("DELETE FROM Nodes_Response_Times WHERE Node_ID=? && Minute<?", [node.Node_ID, firstMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }
}

const alert = (embed) => fetch(process.env.ALERT_DISCORD_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "@everyone", embeds: [embed] }) });
