const { createPool } = require("mysql2/promise");

require("dotenv").config({ path: [".env.local", ".env"], quiet: true });

(async () => {
    const database = createPool({
        host: process.env.DATABASE_HOST,
        user: process.env.DATABASE_USER,
        password: process.env.DATABASE_PASSWORD,
        database: process.env.DATABASE_NAME,
        charset: "utf8mb4_general_ci"
    });

    console.log("Connecting to the database...");
    try {
        await database.query("SELECT 1");
        console.log("Connected to the database.");
    } catch (error) {
        console.log("Cannot connect to the database - " + error);
        return;
    }

    await require("./src/database").init(database);
    await require("./src/services").init(database);
    await require("./src/status").init(database);
    await require("./src/smokeping").init(database);
})();
