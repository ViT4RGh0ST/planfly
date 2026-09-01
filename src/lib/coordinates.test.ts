import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatCoordinates, parseCoordinates } from "./coordinates";

/**
 * Reading a point out of whatever somebody pasted.
 *
 * Nobody types coordinates. They open a map, find the branch and copy — so what
 * arrives is a pair of numbers or a whole URL, and getting it wrong does not
 * fail: it puts a shop in the wrong city on a map that looks perfectly fine.
 */
describe("the coordinates somebody pasted", () => {
  it("reads the bare pair, however it is separated", () => {
    assert.deepEqual(parseCoordinates("10.4806, -66.9036"), { lat: "10.4806", lon: "-66.9036" });
    assert.deepEqual(parseCoordinates("10.4806 -66.9036"), { lat: "10.4806", lon: "-66.9036" });
    assert.deepEqual(parseCoordinates("  10.4806;-66.9036 "), { lat: "10.4806", lon: "-66.9036" });
  });

  it("reads them out of the links the common maps produce", () => {
    assert.deepEqual(
      parseCoordinates("https://www.openstreetmap.org/#map=19/10.48060/-66.90360"),
      { lat: "10.4806", lon: "-66.9036" },
    );
    assert.deepEqual(
      parseCoordinates("https://maps.google.com/maps/place/Farmatodo/@10.4806,-66.9036,17z"),
      { lat: "10.4806", lon: "-66.9036" },
    );
    assert.deepEqual(parseCoordinates("https://maps.apple.com/?ll=10.4806,-66.9036"), {
      lat: "10.4806",
      lon: "-66.9036",
    });
  });

  it("refuses what is not a point on Earth", () => {
    // Out of range: a transposed pair, which is the mistake that reads as a
    // legitimate place somewhere it has never been.
    assert.equal(parseCoordinates("-66.9036, 200"), null);
    assert.equal(parseCoordinates("95, 10"), null);
    // Null Island is what an empty parse looks like, so it is not accepted as
    // an answer.
    assert.equal(parseCoordinates("0, 0"), null);
    assert.equal(parseCoordinates("la esquina de la panadería"), null);
    assert.equal(parseCoordinates(""), null);
    assert.equal(parseCoordinates(undefined), null);
  });

  it("goes back into the field in the shape it was pasted from", () => {
    assert.equal(formatCoordinates("10.480600", "-66.903600"), "10.4806, -66.9036");
    assert.equal(formatCoordinates(null, null), "");
  });
});
