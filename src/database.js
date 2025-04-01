const { getConfig } = require("raraph84-lib");
const config = getConfig(__dirname + "/..");

/**
 * @param {import("sqlite").Database} tempDatabase 
 */
module.exports.init = async (tempDatabase) => {

    await tempDatabase.run("CREATE TABLE IF NOT EXISTS services_smokeping (service_id INTEGER NOT NULL, start_time INTEGER NOT NULL, duration INTEGER NOT NULL, sent INTEGER NOT NULL, lost INTEGER DEFAULT NULL, med_response_time INTEGER DEFAULT NULL, min_response_time INTEGER DEFAULT NULL, max_response_time INTEGER DEFAULT NULL)");
};

let saving = false;

/**
 * @param {import("mysql2/promise").Pool} database 
 * @param {import("sqlite").Database} tempDatabase 
 */
module.exports.save = async (database, tempDatabase) => {

    if (saving) return;
    saving = true;

    const pings = await tempDatabase.all("SELECT * FROM services_smokeping");

    for (const ping of pings) {

        try {
            await database.query(
                "INSERT INTO services_smokeping (service_id, checker_id, start_time, duration, sent, lost, med_response_time, min_response_time, max_response_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [ping.service_id, config.checkerId, ping.start_time, ping.duration, ping.sent, ping.lost, ping.med_response_time, ping.min_response_time, ping.max_response_time]
            );
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
            continue;
        }

        await tempDatabase.run("DELETE FROM services_smokeping WHERE service_id=? AND start_time=?", [ping.service_id, ping.start_time]);
    }

    saving = false;
};
