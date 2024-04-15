const { createPool } = require("mysql");
const { REST } = require("@discordjs/rest");
const { getConfig, TaskManager, query } = require("raraph84-lib");
const { checkWebsite, checkMinecraft, checkApi, checkWs, checkBot } = require("./checkers");
const pLimit = require("p-limit");
const config = getConfig(__dirname);

const tasks = new TaskManager();

const database = createPool(config.database);
tasks.addTask((resolve, reject) => {
    console.log("Connexion à la base de données...");
    query(database, "SELECT 1").then(() => {
        console.log("Connecté à la base de données !");
        resolve();
    }).catch((error) => {
        console.log("Impossible de se connecter à la base de données - " + error);
        reject();
    });
}, (resolve) => database.end(() => resolve()));

let checkerInterval;
tasks.addTask((resolve) => {
    checkerInterval = setInterval(() => checkNodes(), 60 * 1000);
    resolve();
}, (resolve) => { clearInterval(checkerInterval); resolve(); });

tasks.run();

let onlineAlerts;
let offlineAlerts;
let currentDate;
let currentMinute;

const checkNodes = async () => {

    console.log("Vérification des statuts des services...");

    onlineAlerts = [];
    offlineAlerts = [];
    currentDate = Date.now();
    currentMinute = Math.floor(currentDate / 1000 / 60);

    let nodes;
    try {
        nodes = await query(database, "SELECT * FROM Nodes WHERE !Disabled");
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    const limit = pLimit(5);

    const checks = await Promise.all(nodes.map((node) => limit(async () => {

        let responseTime;
        try {
            if (node.Type === "website") responseTime = await checkWebsite(node.Host);
            else if (node.Type === "minecraft") responseTime = await checkMinecraft(node.Host);
            else if (node.Type === "api") responseTime = await checkApi(node.Host);
            else if (node.Type === "gateway") responseTime = await checkWs(node.Host);
            else if (node.Type === "bot") await checkBot(node.Host);
        } catch (error) {
            return { online: false, error: error instanceof AggregateError ? error.errors.map((error) => error.toString()).join(" - ") : error.toString() };
        }

        return { online: true, responseTime };
    })));

    for (let i = 0; i < nodes.length; i++) {

        const node = nodes[i];
        const check = checks[i];

        if (node.Type !== "bot") {
            if (check.online) await nodeOnline(node, check.responseTime);
            else await nodeOffline(node, check.error);
        } else {
            if (check.online) await nodeOnline(node);
            else if (error !== "Check failed") await nodeOffline(node, check.error);
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
            stillDown = await query(database, "SELECT Nodes.* FROM Nodes_Events INNER JOIN Nodes ON Nodes.Node_ID=Nodes_Events.Node_ID WHERE (Nodes_Events.Node_ID, Minute) IN (SELECT Node_ID, MAX(Minute) AS Minute FROM Nodes_Events GROUP BY Node_ID) && Online=0 && Disabled=0");
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
        lastStatus = (await query(database, "SELECT * FROM Nodes_Events WHERE Node_ID=? ORDER BY Minute DESC LIMIT 1", [node.Node_ID]))[0];
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }

    return lastStatus ? !!lastStatus.Online : false;
}

const nodeOnline = async (node, responseTime = -1) => {

    if (!await getLastStatus(node)) {

        try {
            await query(database, "INSERT INTO Nodes_Events VALUES (?, ?, 1)", [node.Node_ID, currentMinute]);
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }

        onlineAlerts.push(node);
    }

    try {
        await query(database, "INSERT INTO Nodes_Statuses VALUES (?, ?, 1)", [node.Node_ID, currentMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }

    if (responseTime >= 0) {
        try {
            await query(database, "INSERT INTO Nodes_Response_Times VALUES (?, ?, ?)", [node.Node_ID, currentMinute, responseTime]);
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }
    }

    await updateDailyUptime(node);
    await updateDailyResponseTime(node);
}

const nodeOffline = async (node, error) => {

    if (await getLastStatus(node)) {

        try {
            await query(database, "INSERT INTO Nodes_Events VALUES (?, ?, 0)", [node.Node_ID, currentMinute]);
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
        }

        offlineAlerts.push({ ...node, error });
    }

    try {
        await query(database, "INSERT INTO Nodes_Statuses VALUES (?, ?, 0)", [node.Node_ID, currentMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }

    await updateDailyUptime(node);
    await updateDailyResponseTime(node);
}

const updateDailyUptime = async (node) => {

    const day = Math.floor(currentDate / 1000 / 60 / 60 / 24) - 1;
    const firstMinute = day * 24 * 60;

    let lastDailyUptime;
    try {
        lastDailyUptime = (await query(database, "SELECT * FROM Nodes_Daily_Uptimes WHERE Node_ID=? ORDER BY Day DESC LIMIT 1", [node.Node_ID]))[0];
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    if (lastDailyUptime && lastDailyUptime.Day === day)
        return;

    let statuses;
    try {
        statuses = await query(database, "SELECT Minute, Online FROM Nodes_Statuses WHERE Node_ID=? && Minute>=?", [node.Node_ID, firstMinute]);
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
        await query(database, "INSERT INTO Nodes_Daily_Uptimes VALUES (?, ?, ?)", [node.Node_ID, day, uptime]);
        await query(database, "DELETE FROM Nodes_Statuses WHERE Node_ID=? && Minute<?", [node.Node_ID, firstMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }
}

const updateDailyResponseTime = async (node) => {

    const day = Math.floor(currentDate / 1000 / 60 / 60 / 24) - 1;
    const firstMinute = day * 24 * 60;

    let lastDailyResponseTime;
    try {
        lastDailyResponseTime = (await query(database, "SELECT * FROM Nodes_Daily_Response_Times WHERE Node_ID=? ORDER BY Day DESC LIMIT 1", [node.Node_ID]))[0];
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    if (lastDailyResponseTime && lastDailyResponseTime.Day === day)
        return;

    let responseTimes;
    try {
        responseTimes = await query(database, "SELECT Minute, Response_Time FROM Nodes_Response_Times WHERE Node_ID=? && Minute>=?", [node.Node_ID, firstMinute]);
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
        await query(database, "INSERT INTO Nodes_Daily_Response_Times VALUES (?, ?, ?)", [node.Node_ID, day, averageResponseTime]);
        await query(database, "DELETE FROM Nodes_Response_Times WHERE Node_ID=? && Minute<?", [node.Node_ID, firstMinute]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
    }
}

const alert = async (embed) => {

    const rest = new REST({ version: "9" }).setToken(config.alertBotToken);

    for (const alertUser of config.alertUsers) {
        const channel = await rest.post("/users/@me/channels", { body: { recipients: [alertUser] } });
        await rest.post("/channels/" + channel.id + "/messages", { body: { embeds: [embed] } });
    }
}
