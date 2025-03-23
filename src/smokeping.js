const { genPingSessionId, releasePingSessionId, median } = require("./utils");
const net = require("net");
const ping = require("net-ping");

let pings = [];

/**
 * @param {number} checkerId 
 * @param {{ id: number; ip: string; }} checkerId 
 * @param {import("mysql2/promise").Pool} database 
 */
const smokeping = async (checkerId, services, database) => {

    services.forEach((service, i) => setTimeout(async () => {

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

    }, 2000 / services.length * i));

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
                await database.query(
                    "INSERT INTO services_smokeping (service_id, checker_id, start_time, duration, sent, lost, med_response_time, min_response_time, max_response_time) VALUES (?, ?, ?, 10, 5, ?, ?, ?, ?)",
                    [service, checkerId, time, lost, med, min, max]
                );
            } catch (error) {
                console.log(`SQL Error - ${__filename} - ${error}`);
            }
        }
    }
};

module.exports = { smokeping };
