"use strict";
// Added for fb-main: generic authenticated GraphQL call (same transport as setPostReaction).
// api.graphqlRaw(docId, friendlyName, variables) -> parsed response JSON
const { parseAndCheckLogin } = require("../../utils/client");

module.exports = function (defaultFuncs, api, ctx) {
  return function graphqlRaw(docId, friendlyName, variables) {
    const form = {
      av: ctx.userID,
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: friendlyName,
      doc_id: String(docId),
      variables: typeof variables === "string" ? variables : JSON.stringify(variables || {})
    };
    return defaultFuncs
      .post("https://www.facebook.com/api/graphql/", ctx.jar, form)
      .then(parseAndCheckLogin(ctx, defaultFuncs))
      .then((resData) => {
        if (resData && resData.errors && resData.errors.length) {
          const e = new Error(resData.errors[0].message || "graphql error");
          e.errors = resData.errors;
          throw e;
        }
        return resData;
      });
  };
};
