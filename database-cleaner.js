const { createPool } = require("mysql2/promise");
const { getConfig, TaskManager } = require("raraph84-lib");
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

const sqls = [];

tasks.addTask(async (resolve) => {

    let nodes;
    try {
        [nodes] = await database.query("SELECT * FROM Nodes");
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        reject();
        return;
    }

    console.log("Cleaning nodes daily response times...");

    let nodesDailyResponseTimes;
    try {
        [nodesDailyResponseTimes] = await database.query("SELECT * FROM Nodes_Daily_Response_Times GROUP BY Node_ID");
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        reject();
        return;
    }

    for (const nodesDailyResponseTime of nodesDailyResponseTimes) {
        const node = nodes.find((node) => node.Node_ID === nodesDailyResponseTime.Node_ID);
        if (!node) {
            console.log(`Node ${nodesDailyResponseTime.Node_ID} not found in nodes table, deleting...`);
            sqls.push(`DELETE FROM Nodes_Daily_Response_Times WHERE Node_ID = ${nodesDailyResponseTime.Node_ID};`);
        }
    }

    console.log("Cleaning nodes daily uptimes...");

    let nodesDailyUptimes;
    try {
        [nodesDailyUptimes] = await database.query("SELECT * FROM Nodes_Daily_Uptimes GROUP BY Node_ID");
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        reject();
        return;
    }

    for (const nodesDailyUptime of nodesDailyUptimes) {
        const node = nodes.find((node) => node.Node_ID === nodesDailyUptime.Node_ID);
        if (!node) {
            console.log(`Node ${nodesDailyUptime.Node_ID} not found in nodes table, deleting...`);
            sqls.push(`DELETE FROM Nodes_Daily_Uptimes WHERE Node_ID = ${nodesDailyUptime.Node_ID};`);
        }
    }

    console.log("Cleaning nodes events...");

    let nodesEvents;
    try {
        [nodesEvents] = await database.query("SELECT * FROM Nodes_Events GROUP BY Node_ID");
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        reject();
        return;
    }

    for (const nodesEvent of nodesEvents) {
        const node = nodes.find((node) => node.Node_ID === nodesEvent.Node_ID);
        if (!node) {
            console.log(`Node ${nodesEvent.Node_ID} not found in nodes table, deleting...`);
            sqls.push(`DELETE FROM Nodes_Events WHERE Node_ID = ${nodesEvent.Node_ID};`);
        }
    }

    console.log("Cleaning nodes response times...");

    let nodesResponseTimes;
    try {
        [nodesResponseTimes] = await database.query("SELECT * FROM Nodes_Response_Times GROUP BY Node_ID");
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        reject();
        return;
    }

    for (const nodesResponseTime of nodesResponseTimes) {
        const node = nodes.find((node) => node.Node_ID === nodesResponseTime.Node_ID);
        if (!node) {
            console.log(`Node ${nodesResponseTime.Node_ID} not found in nodes table, deleting...`);
            sqls.push(`DELETE FROM Nodes_Response_Times WHERE Node_ID = ${nodesResponseTime.Node_ID};`);
        }
    }

    console.log("Cleaning nodes statuses...");

    let nodesStatuses;
    try {
        [nodesStatuses] = await database.query("SELECT * FROM Nodes_Statuses GROUP BY Node_ID");
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        reject();
        return;
    }

    for (const nodesStatus of nodesStatuses) {
        const node = nodes.find((node) => node.Node_ID === nodesStatus.Node_ID);
        if (!node) {
            console.log(`Node ${nodesStatus.Node_ID} not found in nodes table, deleting...`);
            sqls.push(`DELETE FROM Nodes_Statuses WHERE Node_ID = ${nodesStatus.Node_ID};`);
        }
    }

    let pages;
    try {
        [pages] = await database.query("SELECT * FROM Pages");
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        reject();
        return;
    }

    console.log("Cleaning pages nodes...");

    let pagesNodes;
    try {
        [pagesNodes] = await database.query("SELECT * FROM Pages_Nodes");
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        reject();
        return;
    }

    for (const pagesNode of pagesNodes) {
        const page = pages.find((page) => page.Page_ID === pagesNode.Page_ID);
        const node = nodes.find((node) => node.Node_ID === pagesNode.Node_ID);
        if (!page || !node) {
            console.log(`Page ${pagesNode.Page_ID} or node ${pagesNode.Node_ID} not found, deleting...`);
            sqls.push(`DELETE FROM Pages_Nodes WHERE Page_ID = ${pagesNode.Page_ID} && Node_ID = ${pagesNode.Node_ID};`);
        }
    }

    console.log("Cleaning pages subpages...");

    let pagesSubpages;
    try {
        [pagesSubpages] = await database.query("SELECT * FROM Pages_Subpages");
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        reject();
        return;
    }

    for (const pagesSubpage of pagesSubpages) {
        const page = pages.find((page) => page.Page_ID === pagesSubpage.Page_ID);
        const subpage = pages.find((page) => page.Page_ID === pagesSubpage.Subpage_ID);
        if (!page || !subpage) {
            console.log(`Page ${pagesSubpage.Page_ID} or subpage ${pagesSubpage.Subpage_ID} not found, deleting...`);
            sqls.push(`DELETE FROM Pages_Subpages WHERE Page_ID = ${pagesSubpage.Page_ID} && Subpage_ID = ${pagesSubpage.Subpage_ID};`);
        }
    }

    console.log("Finished !");
    console.log(sqls.join("\n"));
    await database.end();
    resolve();

}, (resolve) => resolve());

tasks.run();
