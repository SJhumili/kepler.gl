// Copyright (c) 2019 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

import wktParser from 'wellknown';
import normalize from '@mapbox/geojson-normalize';
import {Analyzer} from 'type-analyzer';
import bbox from '@turf/bbox';
import {extent} from 'd3-array';

import {
  getSampleData,
  timeToUnixMilli,
  notNullorUndefined
} from 'utils/data-utils';

export function parseGeoJsonRawFeature(rawFeature) {
  if (typeof rawFeature === 'object') {
    // Support geojson feature as object
    // probably need to normalize it as well
    const normalized = normalize(rawFeature);
    if (!normalized || !Array.isArray(normalized.features)) {
      // fail to normalize geojson
      return null;
    }

    return normalized.features[0];
  } else if (typeof rawFeature === 'string') {

    return parseGeometryFromString(rawFeature);
  } else if (Array.isArray(rawFeature)) {
    // Support geojson  linestring as an array of points
    return {
      type: 'Feature',
      geometry: {
        // why do we need to flip it...
        coordinates: rawFeature.map(pts => [pts[1], pts[0]]),
        type: 'LineString'
      }
    };
  }

  return null;
}
/**
 * Parse raw data to GeoJson feature
 * @param allData
 * @param getFeature
 * @returns {{}}
 */
export function getGeojsonDataMaps(allData, getFeature) {
  // console.time('getGeojsonDataMaps')
  const acceptableTypes = [
    'Point',
    'MultiPoint',
    'LineString',
    'MultiLineString',
    'Polygon',
    'MultiPolygon',
    'GeometryCollection'
  ];

  const dataToFeature = [];

  for (let index = 0; index < allData.length; index++) {
    const feature = parseGeoJsonRawFeature(getFeature(allData[index]));

    if (
      feature &&
      feature.geometry &&
      acceptableTypes.includes(feature.geometry.type)
    ) {
      // store index of the data in feature properties
      feature.properties = {
        ...(feature.properties || {}),
        index
      };

      dataToFeature[index] = feature;
    }

  }

  return dataToFeature;
}

/**
 * Parse geojson from string
 * @param {String} geoString
 * @returns {null | Object} geojson object or null if failed
 */
export function parseGeometryFromString(geoString) {
  let parsedGeo;

  // try parse as geojson string
  // {"type":"Polygon","coordinates":[[[-74.158491,40.83594]]]}
  try {
    parsedGeo = JSON.parse(geoString);
  } catch (e) {
    // keep trying to parse
  }

  // try parse as wkt
  if (!parsedGeo) {
    try {
      parsedGeo = wktParser(geoString);
    } catch (e) {
      return null;
    }
  }

  if (!parsedGeo) {
    return null;
  }

  const normalized = normalize(parsedGeo);

  if (!normalized || !Array.isArray(normalized.features)) {
    // fail to normalize geojson
    return null;
  }

  return normalized.features[0];
}

export function getGeojsonBounds(features = []) {
  // 70 ms for 10,000 polygons
  // here we only pick couple
  const maxCount = 10000;
  const samples =
    features.length > maxCount ? getSampleData(features, maxCount) : features;

  const nonEmpty = samples.filter(
    d =>
      d && d.geometry && d.geometry.coordinates && d.geometry.coordinates.length
  );

  try {
    return bbox({
      type: 'FeatureCollection',
      features: nonEmpty
    });
  } catch (e) {
    return null;
  }
}

export const featureToDeckGlGeoType = {
  Point: 'point',
  MultiPoint: 'point',
  LineString: 'line',
  MultiLineString: 'line',
  Polygon: 'polygon',
  MultiPolygon: 'polygon'
};

/**
 * Parse geojson from string
 * @param {array} geoJson object values
 * @returns {Object} mapping of feature type existence
 */
export function getGeojsonFeatureTypes(allFeatures) {
  const featureTypes = {};
  for (let f = 0; f < allFeatures.length; f++) {
    const geoType =
      featureToDeckGlGeoType[
        allFeatures[f].geometry && allFeatures[f].geometry.type
      ];
    if (geoType) {
      featureTypes[geoType] = true;
    }
  }

  return featureTypes;
}

/**
 * Parse geojson from string
 * @param {array} geojson feature object values
 * @returns {boolean} whether the geometry coordinates has length of 4
 */
export function coordHasLength4(samples) {
  let hasLength4 = true;
  for (let i = 0; i < samples.length; i += 1) {
    hasLength4 = !samples[i].geometry.coordinates.find(c => c.length < 4);
    if (!hasLength4) {
      break;
    }
  }
  return hasLength4;
}

/**
 * Check whether geojson linestring's 4th coordinate is 1) not timestamp 2) unix time stamp 3) real date time
 * @param {array} data array to be tested if its elements are timestamp
 * @returns {string} the type of timestamp: unix/datetime/invalid(not timestamp)
 */

export function containValidTime(timestamps) {
  const formattedTimeStamps = timestamps.map(ts => ({ts}));
  const analyzedType = Analyzer.computeColMeta(formattedTimeStamps)[0];

  if (!analyzedType || analyzedType.category !== 'TIME') {
    return false;
  }
  return analyzedType;
}

/**
 * Check if geojson features are trip layer animatable by meeting 3 conditions
 * @param {array} features array of geojson feature objects
 * @returns {boolean} whether it is trip layer animatable
 */
export function isTripGeoJsonField(allData, field) {
  const getValue = d => d[field.tableFieldIndex - 1];
  const maxCount = 10000;
  const sampleRawFeatures =
    allData.length > maxCount ? getSampleData(allData, maxCount, getValue) : allData.map(getValue);

  const features = sampleRawFeatures.map(parseGeoJsonRawFeature);

  let isTrip = false;
  const featureTypes = getGeojsonFeatureTypes(features);
  // condition 1: contain line string
  const hasLineString = Boolean(featureTypes.line);
  if (!hasLineString) {
    return isTrip;
  }

  // condition 2:sample line strings contain 4 coordinates
  const HasLength4 = coordHasLength4(features);
  if (!HasLength4) {
    return isTrip;
  }

  // condition 3:the 4th coordinate of the first feature line strings is valid time
  const tsHolder = features[0].geometry.coordinates.map(
    coord => coord[3]
  );

  const hasValidTime = containValidTime(tsHolder);
  if (hasValidTime) {
    isTrip = true;
  }

  return isTrip;
}

/**
 * Get unix timestamp from animatable geojson for deck.gl trip layer
 * @param {Array<Object>} dataToFeature array of geojson feature objects, can be null
 * @returns {Array<Number>} unix timestamp in milliseconds
 */
export function parseTripGeoJsonTimestamp(dataToFeature) {
  // Analyze type based on coordinates of the 1st lineString
  // select a sample trip to analyze time format
  const empty = {dataToTimeStamp: [], animationDomain: null};
  const sampleTrip = dataToFeature.find(
    f =>
      f &&
      f.geometry &&
      f.geometry.coordinates &&
      f.geometry.coordinates.length >= 3
  );

  // if no valid geometry
  if (!sampleTrip) {
    return empty;
  }

  const analyzedType = containValidTime(
    sampleTrip.geometry.coordinates.map(coord => coord[3])
  );

  if (!analyzedType) {
    return empty;
  }

  const {format} = analyzedType;
  const getTimeValue = coord =>
    coord && notNullorUndefined(coord[3])
      ? timeToUnixMilli(coord[3], format)
      : null;

  const dataToTimeStamp = dataToFeature.map(f =>
    f && f.geometry && Array.isArray(f.geometry.coordinates)
      ? f.geometry.coordinates.map(getTimeValue)
      : null
  );

  const animationDomain = getAnimationDomainFromTimestamps(dataToTimeStamp);

  return {dataToTimeStamp, animationDomain};
}

function findMinFromSorted(list = []) {
  let i = 0;
  while (i < list.length) {
    if (notNullorUndefined(list[i])) {
      return list[i]
    }
    i++;
  }
  return null;
}

function findMaxFromSorted(list = []) {
  let i = list.length - 1;
  while (i > 0) {
    if (notNullorUndefined(list[i])) {
      return list[i]
    }
    i--;
  }
  return null;
}

export function getAnimationDomainFromTimestamps(dataToTimeStamp = []) {
  return dataToTimeStamp.reduce(
    (accu, tss) => {
      accu[0] = Math.min(accu[0], findMinFromSorted(tss));
      accu[1] = Math.max(accu[1], findMaxFromSorted(tss));
      return accu;
    },
    [Number(Infinity), -Infinity]
  );
}
