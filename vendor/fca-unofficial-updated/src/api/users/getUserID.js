"use strict";

const log = require("../../../func/logAdapter");
const { formatID } = require("../../utils/format");
const { parseAndCheckLogin } = require("../../utils/loginParser");

function formatData(data) {
  return {
    userID: formatID(data.id.toString()),
    photoUrl: data.profile_picture.uri,
    indexRank: null,
    name: data.name,
    isVerified: data.is_verified,
    profileUrl: data.url,
    category: null,
    score: null,
    type: data.__typename
  };
}

module.exports = function(defaultFuncs, api, ctx) {
  return function getUserID(name, callback) {
    let resolveFunc = function() {};
    let rejectFunc = function() {};
    const returnPromise = new Promise(function(resolve, reject) {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    if (!callback) {
      callback = function(err, friendList) {
        if (err) {
          return rejectFunc(err);
        }
        resolveFunc(friendList);
      };
    }

    const form = {
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: "SearchCometGlobalTypeaheadQuery",
      variables: JSON.stringify({
        count: 10,
        input: {
          query: name,
          type: "GLOBAL",
          context: {
            source: "SEARCH_BOX"
          }
        }
      }),
      doc_id: "5009315269112105"
    };

    defaultFuncs
      .post("https://www.facebook.com/api/graphql/", ctx.jar, form)
      .then(parseAndCheckLogin(ctx, defaultFuncs))
      .then(function(resData) {
        if (resData.errors) {
          throw resData;
        }

        const data = resData.data.search_typeahead.edges.map(edge => edge.node);

        callback(null, data.map(formatData));
      })
      .catch(function(err) {
        log.error("getUserID", err);
        return callback(err);
      });

    return returnPromise;
  };
};
