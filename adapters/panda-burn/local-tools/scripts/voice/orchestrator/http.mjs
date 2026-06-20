export async function readJson(request) {
  const text = Buffer.concat(await requestBody(request)).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export async function readBytes(request) {
  return Buffer.concat(await requestBody(request));
}

export function writeJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(chunks));
    request.on("error", reject);
  });
}
