"use strict";

const { getRandomUserAgent } = require("./userAgent");

// Sanitize header value to remove invalid characters
function sanitizeHeaderValue(value) {
  if (value === null || value === undefined) return "";
  let str = String(value);

  if (str.trim().startsWith("[") && str.trim().endsWith("]")) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        return "";
      }
    } catch {
      // Not valid JSON
    }
  }

  str = str.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F\r\n\[\]]/g, "").trim();
  return str;
}

// Sanitize header name to ensure it's valid
function sanitizeHeaderName(name) {
  if (!name || typeof name !== "string") return "";
  return name.replace(/[^\x21-\x7E]/g, "").trim();
}

function getHeaders(url, options, ctx, customHeader) {
  const u = new URL(url);
  const ua = options?.userAgent || getRandomUserAgent();
  const referer = options?.referer || "https://www.facebook.com/";
  const origin = referer.replace(/\/+$/, "");
  const contentType = options?.contentType || "application/x-www-form-urlencoded";
  const acceptLang = options?.acceptLanguage || "en-US,en;q=0.9,vi;q=0.8";
  
  const headers = {
    Host: sanitizeHeaderValue(u.host),
    Origin: sanitizeHeaderValue(origin),
    Referer: sanitizeHeaderValue(referer),
    "User-Agent": sanitizeHeaderValue(ua),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
    "Accept-Language": sanitizeHeaderValue(acceptLang),
    "Accept-Encoding": "gzip, deflate, br",
    "Content-Type": sanitizeHeaderValue(contentType),
    Connection: "keep-alive",
    DNT: "1",
    "Upgrade-Insecure-Requests": "1",
    "sec-ch-ua": "\"Chromium\";v=\"122\", \"Not;A=Brand\";v=\"24\", \"Google Chrome\";v=\"122\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "X-Requested-With": "XMLHttpRequest",
    Pragma: "no-cache",
    "Cache-Control": "no-cache"
  };

  if (ctx?.region) {
    const regionValue = sanitizeHeaderValue(ctx.region);
    if (regionValue) headers["X-MSGR-Region"] = regionValue;
  }

  if (customHeader && typeof customHeader === "object") {
    for (const [key, value] of Object.entries(customHeader)) {
      if (value === null || value === undefined || typeof value === "function" || typeof value === "object") {
        continue;
      }
      const sanitizedKey = sanitizeHeaderName(key);
      const sanitizedValue = sanitizeHeaderValue(value);
      if (sanitizedKey && sanitizedValue !== "") {
        headers[sanitizedKey] = sanitizedValue;
      }
    }
  }

  const sanitizedHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const sanitizedKey = sanitizeHeaderName(key);
    const sanitizedValue = sanitizeHeaderValue(value);
    if (sanitizedKey && sanitizedValue !== "") {
      sanitizedHeaders[sanitizedKey] = sanitizedValue;
    }
  }
  return sanitizedHeaders;
}

module.exports = { getHeaders };
