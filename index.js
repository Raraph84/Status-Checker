const { getConfig, HttpServer } = require("raraph84-lib");
const pLimit = require("p-limit");
const { checkWebsite, checkMinecraft, checkApi, checkWs, checkBot } = require("./checkers");
const config = getConfig(__dirname);

const server = new HttpServer();
server.on("request", async (/** @type {import("raraph84-lib/src/Request")} */ request) => {

    if (request.url !== "/check") {
        request.end(404, "Not found");
        return;
    }

    if (request.method !== "POST") {
        request.end(405, "Method not allowed");
        return;
    }

    if (!request.headers.authorization) {
        request.end(401, "Missing authorization");
        return;
    }

    if (request.headers.authorization !== config.token) {
        request.end(401, "Invalid token");
        return;
    }

    if (!request.jsonBody) {
        request.end(400, "Invalid JSON");
        return;
    }

    if (typeof request.jsonBody.checks === "undefined") {
        request.end(400, "Missing checks");
        return;
    }

    if (!Array.isArray(request.jsonBody.checks)) {
        request.end(400, "Checks must be an array");
        return;
    }

    for (const check of request.jsonBody.checks) {

        if (typeof check !== "object") {
            request.end(400, "Check must be an object");
            return;
        }

        if (typeof check.type === "undefined") {
            request.end(400, "Missing type");
            return;
        }

        if (typeof check.type !== "string") {
            request.end(400, "Type must be a string");
            return;
        }

        if (!["website", "minecraft", "api", "gateway", "bot"].includes(check.type)) {
            request.end(400, "Invalid type");
            return;
        }

        if (typeof check.host === "undefined") {
            request.end(400, "Missing host");
            return;
        }

        if (typeof check.host !== "string") {
            request.end(400, "Host must be a string");
            return;
        }
    }

    const limit = pLimit(4);

    const checks = await Promise.all(request.jsonBody.checks.map((check) => limit(async () => {

        let responseTime;
        try {
            if (check.type === "website") responseTime = await checkWebsite(check.host);
            else if (check.type === "minecraft") responseTime = await checkMinecraft(check.host);
            else if (check.type === "api") responseTime = await checkApi(check.host);
            else if (check.type === "gateway") responseTime = await checkWs(check.host);
            else if (check.type === "bot") await checkBot(check.host);
        } catch (error) {
            return { online: false, error: error.toString() };
        }

        return { online: true, responseTime };

    })));

    request.end(200, { checks });
});

const port = parseInt(process.env.PORT) || 8080;
console.log("Lancement du serveur...");
server.listen(port).then(() => {
    console.log("Serveur lancé sur le port " + port + " !");
}).catch((error) => {
    console.log("Impossible de lancer serveur ! " + error);
});
