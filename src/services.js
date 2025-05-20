const { getConfig } = require("raraph84-lib");
const { promises: dns } = require("dns");
const net = require("net");
const config = getConfig(__dirname + "/..");

let services = [];
module.exports.getServices = () => services;

let updateInterval = null;

/**
 * @param {import("mysql2/promise").Pool} database 
 */
module.exports.init = async (database) => {

    const update = async () => {

        let rawServices;
        try {
            [rawServices] = await database.query("SELECT DISTINCT services.* FROM groups_services INNER JOIN services ON groups_services.service_id=services.service_id WHERE group_id IN (SELECT group_id FROM groups_checkers WHERE checker_id=?)", [config.checkerId]);
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

            if (![0, 4, 6].includes(service.protocol)) {
                newServices.push({ ...service, ipv4: null, ipv6: null, ip: null, error: new Error("Invalid protocol") });
                continue;
            }

            if (net.isIPv4(host)) {

                if (service.protocol === 6)
                    newServices.push({ ...service, ipv4: null, ipv6: null, ip: null, error: new Error("IPv4 address provided for IPv6 protocol") });
                else
                    newServices.push({ ...service, ipv4: host, ipv6: null, ip: host, error: null });

            } else if (net.isIPv6(host)) {

                if (service.protocol === 4)
                    newServices.push({ ...service, ipv4: null, ipv6: null, ip: null, error: new Error("IPv6 address provided for IPv4 protocol") });
                else
                    newServices.push({ ...service, ipv4: null, ipv6: host, ip: host, error: null });

            } else {

                if (service.type === "minecraft") {
                    let results;
                    try {
                        results = await dns.resolveSrv("_minecraft._tcp." + host);
                    } catch (error) {
                    }
                    if (results && results[0])
                        host = results[0].name;
                }

                let ipv6 = null;
                let ipv6error = null;
                let ipv4 = null;
                let ipv4error = null;
                await dns.lookup(host, { family: 6 }).then((res) => ipv6 = res.address).catch((e) => ipv6error = e);
                await dns.lookup(host, { family: 4 }).then((res) => ipv4 = res.address).catch((e) => ipv4error = e);

                if (service.protocol === 4) {
                    if (ipv4) newServices.push({ ...service, ipv4, ipv6, ip: ipv4, error: null });
                    else newServices.push({ ...service, ipv4: null, ipv6: null, ip: null, error: ipv4error });
                } else if (service.protocol === 6) {
                    if (ipv6) newServices.push({ ...service, ipv4, ipv6, ip: ipv6, error: null });
                    else newServices.push({ ...service, ipv4: null, ipv6: null, ip: null, error: ipv6error });
                } else {
                    if (ipv6 || ipv4) newServices.push({ ...service, ipv4, ipv6, ip: ipv6 ?? ipv4, error: null });
                    else newServices.push({ ...service, ipv4: null, ipv6: null, ip: null, error: new AggregateError([ipv6error, ipv4error]) });
                }
            }
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
