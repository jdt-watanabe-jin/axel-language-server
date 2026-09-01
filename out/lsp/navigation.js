"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toLspLocations = toLspLocations;
const node_1 = require("vscode-languageserver/node");
function toLspLocations(locations) {
    return locations.map((location) => node_1.Location.create(location.uri, toLspRange(location.range)));
}
function toLspRange(range) {
    return {
        start: range.start,
        end: range.end
    };
}
//# sourceMappingURL=navigation.js.map