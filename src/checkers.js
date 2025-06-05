const { pingWithPromise } = require("minecraft-ping-js");
const url = require("url");
const http = require("http");
const https = require("https");
const Ws = require("ws");

const genHttpOptions = (host, ip) => {
    const hostUrl = new URL(host);
    const options = {
        ...url.urlToHttpOptions(hostUrl), // Used in http.request(url)
        hostname: ip, // Use already resolved IP
        headers: { host: hostUrl.hostname }, // Set the Host header to the original hostname instead of the IP
        agent: false // Create new agent to avoid ping measurement issues by not reusing already created agent
    };
    if (hostUrl.protocol === "https:") {
        options._defaultAgent = https.globalAgent; // Used in https.request
        options.servername = hostUrl.hostname; // Fixes TLS
    }
    return options;
};

const checkWebsite = (host, ip) =>
    new Promise((resolve, reject) => {
        let finishDate = 0;
        let responseDate = 0;

        const req = http.request(genHttpOptions(host, ip));
        req.on("socket", (socket) => {
            socket.on("connect", () => (finishDate = process.hrtime.bigint()));
            socket.on("secureConnect", () => (finishDate = process.hrtime.bigint()));
        });
        req.on("response", (res) => {
            responseDate = process.hrtime.bigint();
            res.on("data", () => {});
            res.on("end", () => {
                if (res.statusCode !== 200) {
                    reject("Status code (" + res.statusCode + ") is not 200");
                    return;
                }

                resolve(Number(responseDate - finishDate) / 1000000);
            });
        });
        req.on("error", (error) => reject(error));
        req.end();

        setTimeout(() => reject(new Error("timeout")), 10000);
    });

const checkApi = (host, ip) =>
    new Promise((resolve, reject) => {
        let finishDate = 0;
        let responseDate = 0;

        const req = http.request(genHttpOptions(host, ip));
        req.on("socket", (socket) => {
            socket.on("connect", () => (finishDate = process.hrtime.bigint()));
            socket.on("secureConnect", () => (finishDate = process.hrtime.bigint()));
        });
        req.on("response", (res) => {
            responseDate = process.hrtime.bigint();
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try {
                    JSON.parse(data);
                } catch (error) {
                    reject("Invalid JSON");
                    return;
                }

                resolve(Number(responseDate - finishDate) / 1000000);
            });
        });
        req.on("error", (error) => reject(error));
        req.end();

        setTimeout(() => reject(new Error("timeout")), 10000);
    });

const checkWs = (host) =>
    new Promise((resolve, reject) => {
        let openTime = -1;

        const ws = new Ws(host);

        ws.on("open", () => {
            openTime = process.hrtime.bigint();
            ws.send("");
        });

        ws.on("close", () => {
            const endTime = process.hrtime.bigint();
            if (openTime > 0) resolve(Number(endTime - openTime) / 1000000);
        });

        ws.on("error", (error) => reject(error));

        setTimeout(() => reject(new Error("timeout")), 10000);
    });

const checkMinecraft = (host) =>
    new Promise((resolve, reject) => {
        pingWithPromise(host.split(":")[0], parseInt(host.split(":")[1]) || 25565)
            .then((res) => resolve(res.ping))
            .catch((error) => reject(error));

        // Timeout of 10s is handled by the library
    });

module.exports = {
    checkWebsite,
    checkApi,
    checkWs,
    checkMinecraft
};
