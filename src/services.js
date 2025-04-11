const { getConfig } = require("raraph84-lib");
const { promises: dns } = require("dns");
const net = require("net");
const config = getConfig(__dirname + "/..");

let services = [];
module.exports.getServices = () => services;

let updateInterval = null;

module.exports.init = async (database) => {

    const update = async () => {

        let rawServices;
        try {
            [rawServices] = await database.query("SELECT * FROM checkers_services INNER JOIN services ON services.service_id=checkers_services.service_id WHERE checker_id=?", [config.checkerId]);
        } catch (error) {
            console.log(`SQL Error - ${__filename} - ${error}`);
            throw error;
        }

        const newServices = [];

        for (const service of rawServices) {

            let host;
            if (service.type === "server") host = service.host;
            else if (service.type === "minecraft") host = service.host.split(/:/)[0];
            else host = new URL(service.host).hostname.replace(/^\[|]$/g, "");

            let ip = null;
            let error = null;

            if (net.isIPv4(host)) ip = host;
            else if (net.isIPv6(host)) ip = host;
            else {

                if (service.type === "minecraft") {
                    let results;
                    try {
                        results = await dns.resolveSrv("_minecraft._tcp." + host);
                    } catch (error) {
                    }
                    if (results && results[0])
                        host = results[0].name;
                }

                await dns.lookup(host, { family: service.protocol }).then((res) => ip = res.address).catch((e) => error = e);
            }

            newServices.push({ ...service, ip, error });
        }

        services = newServices;

        require("./smokeping").updateServices();
    };

    await update();
    updateInterval = setInterval(() => update().catch(() => { }), 60 * 1000);
};

module.exports.stop = async () => {
    clearInterval(updateInterval);
};
