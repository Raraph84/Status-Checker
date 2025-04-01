const { createPool } = require("mysql2/promise");
const { Database } = require("sqlite3");
const { getConfig, TaskManager } = require("raraph84-lib");
const sqlite = require("sqlite");
const config = getConfig(__dirname);

require("dotenv").config({ path: [".env.local", ".env"] });

const tasks = new TaskManager();

const database = createPool({ password: process.env.DATABASE_PASSWORD, charset: "utf8mb4_general_ci", ...config.database });
tasks.addTask((resolve, reject) => {
    console.log("Connecting to the database...");
    database.query("SELECT 1").then(() => {
        console.log("Connected to the database.");
        resolve();
    }).catch((error) => {
        console.log("Cannot connect to the database - " + error);
        reject();
    });
}, (resolve) => database.end().then(() => resolve()));

/** @type {import("sqlite").Database|null} */
let tempDatabase = null;
tasks.addTask((resolve, reject) => {
    sqlite.open({ filename: "temp.db", driver: Database }).then((db) => {
        tempDatabase = db;
        resolve();
    }).catch((error) => {
        console.log("Cannot open the temporary database - " + error);
        reject();
    });
}, (resolve) => tempDatabase.end().then(() => resolve()));

tasks.addTask((resolve, reject) => require("./src/database").init(tempDatabase).then(resolve).catch(reject), (resolve) => resolve());

let checker = null;
tasks.addTask((resolve, reject) => {
    database.query("SELECT * FROM checkers WHERE checker_id=?", [config.checkerId]).then(([checkers]) => {
        if (!checkers[0]) {
            console.log("Checker does not exist.");
            reject();
            return;
        }
        checker = checkers[0];
        resolve();
    }).catch((error) => {
        console.log(`SQL Error - ${__filename} - ${error}`);
        reject();
    });
}, (resolve) => resolve());

let checkerInterval = null;
tasks.addTask((resolve) => {
    require("./src/smokeping").updateServices(database);
    let lastMinute = -1;
    checkerInterval = setInterval(() => {
        const date = new Date();
        if (date.getMinutes() === lastMinute || date.getSeconds() !== checker.check_second) return;
        lastMinute = date.getMinutes();
        require("./src/status").checkServices(database, checker);
        require("./src/smokeping").updateServices(database);
    }, 500);
    resolve();
}, (resolve) => { clearInterval(checkerInterval); resolve(); });

let smokepingInterval = null;
tasks.addTask((resolve) => {
    smokepingInterval = setInterval(() => require("./src/smokeping").smokeping(database, tempDatabase), 2000);
    resolve();
}, (resolve) => {
    clearInterval(smokepingInterval);
    resolve();
});

tasks.run();
