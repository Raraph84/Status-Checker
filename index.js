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

tasks.addTask(
    (resolve, reject) => require("./src/database").init(tempDatabase).then(resolve).catch(reject),
    (resolve) => database.end().then(resolve)
);

tasks.addTask(
    (resolve, reject) => require("./src/services").init(database).then(resolve).catch(reject),
    (resolve) => require("./src/services").stop().then(resolve)
);

tasks.addTask(
    (resolve, reject) => require("./src/status").init(database).then(resolve).catch(reject),
    (resolve) => require("./src/status").stop().then(resolve)
);

tasks.addTask(
    (resolve, reject) => require("./src/smokeping").init(database, tempDatabase).then(resolve).catch(reject),
    (resolve) => require("./src/smokeping").stop().then(resolve)
);

tasks.run();
