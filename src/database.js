const { Database } = require("sqlite3");
const sqlite = require("sqlite");

/** @type {import("sqlite").Database|null} */
let tempDatabase = null;
module.exports.getTempDatabase = () => tempDatabase;

let saveInterval = null;

/**
 * @param {import("mysql2/promise").Pool} database
 */
module.exports.init = async (database) => {
    try {
        tempDatabase = await sqlite.open({ filename: "temp.db", driver: Database });
    } catch (error) {
        console.log("Cannot open the temporary database - " + error);
        throw error;
    }

    await tempDatabase.run(
        "CREATE TABLE IF NOT EXISTS services_smokeping (service_id INTEGER NOT NULL, checker_id INTEGER NOT NULL, start_time INTEGER NOT NULL, duration INTEGER NOT NULL, sent INTEGER NOT NULL, lost INTEGER DEFAULT NULL, med_response_time INTEGER DEFAULT NULL, min_response_time INTEGER DEFAULT NULL, max_response_time INTEGER DEFAULT NULL, downs INTEGER DEFAULT NULL)"
    );

    await save(database);
    saveInterval = setInterval(() => save(database), 5 * 60 * 1000);
};

module.exports.stop = async () => {
    clearInterval(saveInterval);
    await tempDatabase.close();
};

let saving = false;

/**
 * @param {import("mysql2/promise").Pool} database
 */
const save = async (database) => {
    if (saving) return;
    saving = true;

    const pings = await tempDatabase.all("SELECT * FROM services_smokeping");

    for (const ping of pings) {
        try {
            await database.query(
                "INSERT INTO services_smokeping (service_id, checker_id, start_time, duration, sent, lost, med_response_time, min_response_time, max_response_time, downs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE service_id=service_id",
                [
                    ping.service_id,
                    ping.checker_id,
                    ping.start_time,
                    ping.duration,
                    ping.sent,
                    ping.lost,
                    ping.med_response_time,
                    ping.min_response_time,
                    ping.max_response_time,
                    ping.downs
                ]
            );
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
            continue;
        }

        await tempDatabase.run("DELETE FROM services_smokeping WHERE service_id=? AND start_time=?", [
            ping.service_id,
            ping.start_time
        ]);
    }

    saving = false;
};
