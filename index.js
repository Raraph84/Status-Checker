const { createPool } = require("mysql2/promise");
const { TaskManager } = require("raraph84-lib");

require("dotenv").config({ path: [".env.local", ".env"] });

const tasks = new TaskManager();

const database = createPool({
    host: process.env.DATABASE_HOST,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    charset: "utf8mb4_general_ci"
});
tasks.addTask(
    (resolve, reject) => {
        console.log("Connecting to the database...");
        database
            .query("SELECT 1")
            .then(() => {
                console.log("Connected to the database.");
                resolve();
            })
            .catch((error) => {
                console.log("Cannot connect to the database - " + error);
                reject();
            });
    },
    (resolve) => database.end().then(() => resolve())
);

tasks.addTask(
    (resolve, reject) => require("./src/database").init(database).then(resolve).catch(reject),
    (resolve) => require("./src/database").stop().then(resolve)
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
    (resolve, reject) => require("./src/smokeping").init(database).then(resolve).catch(reject),
    (resolve) => require("./src/smokeping").stop().then(resolve)
);

tasks.run();
