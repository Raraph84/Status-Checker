const { createPool } = require("mysql2/promise");
const { getConfig, TaskManager } = require("raraph84-lib");
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
    require("./src/smokeping").updateServices(checker.checker_id, database);
    let lastMinute = -1;
    checkerInterval = setInterval(() => {
        const date = new Date();
        if (date.getMinutes() === lastMinute || date.getSeconds() !== checker.check_second) return;
        lastMinute = date.getMinutes();
        require("./src/status").checkServices(database, checker);
        require("./src/smokeping").updateServices(checker.checker_id, database);
    }, 500);
    resolve();
}, (resolve) => { clearInterval(checkerInterval); resolve(); });

let smokepingInterval;
tasks.addTask((resolve) => {
    smokepingInterval = setInterval(() => require("./src/smokeping").smokeping(checker.checker_id, database), 2000);
    resolve();
}, (resolve) => {
    clearInterval(smokepingInterval);
    resolve();
});

tasks.run();
