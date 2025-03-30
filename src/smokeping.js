const { genPingSessionId, releasePingSessionId, median } = require("./utils");
const net = require("net");
const dns = require("dns/promises");
const ping = require("net-ping");

let pings = [];
let smokepingServices = [];

/**
 * @param {import("mysql2/promise").Pool} database 
 * @param {import("sqlite").Database} tempDatabase 
 */
const smokeping = async (database, tempDatabase) => {

    smokepingServices.forEach((service, i) => setTimeout(async () => {

        const time = Math.floor(Date.now() / 1000 / 10);
        const sessionId = genPingSessionId();

        const session = ping.createSession({
            sessionId,
            networkProtocol: net.isIPv6(service.ip) ? ping.NetworkProtocol.IPv6 : ping.NetworkProtocol.IPv4,
            timeout: 1000,
            packetSize: 64,
            ttl: 64,
            retries: 0
        });

        let res = null;
        let error = null;
        try {
            res = await new Promise((resolve, reject) => {
                session.pingHost(service.ip, (error, _target, sent, rcvd) => {
                    if (error) reject(error);
                    else resolve(Math.round(Number(rcvd - sent) / 10));
                });
            });
        } catch (e) {
            error = e;
        }

        session.close();
        releasePingSessionId(sessionId);

        pings.push({ time, id: service.id, latency: res, error });

    }, 2000 / smokepingServices.length * i));

    const time = Math.floor(Date.now() / 1000 / 10);
    const times = pings.map((ping) => ping.time).filter((t) => t <= time - 2).filter((t, i, a) => a.indexOf(t) === i);

    for (const time of times) {

        const timePings = pings.filter((ping) => ping.time === time);
        pings = pings.filter((ping) => ping.time !== time);

        const services = timePings.map((service) => service.id).filter((s, i, a) => a.indexOf(s) === i);
        for (const service of services) {

            const servicePings = timePings.filter((ping) => ping.id === service);
            if (servicePings.length !== 5) continue;

            const latencies = servicePings.map((ping) => ping.latency).filter((ping) => ping);
            const med = latencies.length ? median(latencies) : null;
            const min = latencies.length ? Math.min(...latencies) : null;
            const max = latencies.length ? Math.max(...latencies) : null;
            const lost = (servicePings.length - latencies.length) || null;

            try {
                await tempDatabase.run(
                    "INSERT INTO services_smokeping (service_id, start_time, duration, sent, lost, med_response_time, min_response_time, max_response_time) VALUES (?, ?, 10, 5, ?, ?, ?, ?)",
                    [service, time, lost, med, min, max]
                );
            } catch (error) {
                console.log(`SQL Error - ${__filename} - ${error}`);
            }
        }
    }

    await require("./database").save();
};

/**
 * @param {number} checkerId 
 * @param {import("mysql2/promise").Pool} database 
 */
const updateServices = async (checkerId, database) => {

    let services;
    try {
        [services] = await database.query("SELECT * FROM checkers_services INNER JOIN services ON services.service_id=checkers_services.service_id WHERE checker_id=? AND type='server' AND !disabled", [checkerId]);
    } catch (error) {
        console.log(`SQL Error - ${__filename} - ${error}`);
        return;
    }

    smokepingServices = smokepingServices.filter((service) => services.some((s) => service.id === s.service_id));

    for (const service of services) {

        let serverIp;
        if (net.isIP(service.host)) serverIp = service.host;
        else {
            try {
                serverIp = (await dns.lookup(service.host, { family: service.protocol })).address;
            } catch (error) {
                continue;
            }
        }

        const old = smokepingServices.find((s) => s.id === service.service_id);
        if (old) old.ip = serverIp;
        else smokepingServices.push({ id: service.service_id, ip: serverIp });
    }
};

module.exports = { smokeping, updateServices };
