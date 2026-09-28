#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { cleanObject, flattenArraysInObject, pickBySchema, diagnoseJsonPath, findPdpPresentation, extractAmenities, extractHighlights, keyAmenityGroups } from "./util.js";
import robotsParser from "robots-parser";
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
    return process.env.MCP_SERVER_VERSION || packageJson.version || "unknown";
  } catch (error) {
    return process.env.MCP_SERVER_VERSION || "unknown";
  }
}

const VERSION = getVersion();

// Amenity filter IDs, taken from the filter panel Airbnb embeds in its search page
// (filters.filterPanel ... discreteFilterItems[].searchParams, key "amenities").
// Search results carry no per-listing amenity data, so filtering on these IDs is
// the only way to make a search result say anything reliable about amenities.
// Waterfront sits in the same panel section but is a knowledge-graph tag, not an
// amenity ID, so it goes out as kg_and_tags[] and can never be relaxed.
const AMENITY_IDS: Record<string, { id?: number; tag?: string; title: string }> = {
  waterfront:               { tag: "Tag:686", title: "Waterfront" },
  wifi:                     { id: 4,    title: "Wifi" },
  air_conditioning:         { id: 5,    title: "Air conditioning" },
  pool:                     { id: 7,    title: "Pool" },
  kitchen:                  { id: 8,    title: "Kitchen" },
  free_parking:             { id: 9,    title: "Free parking" },
  smoking_allowed:          { id: 11,   title: "Smoking allowed" },
  gym:                      { id: 15,   title: "Gym" },
  breakfast:                { id: 16,   title: "Breakfast" },
  hot_tub:                  { id: 25,   title: "Hot tub" },
  indoor_fireplace:         { id: 27,   title: "Indoor fireplace" },
  heating:                  { id: 30,   title: "Heating" },
  washer:                   { id: 33,   title: "Washer" },
  dryer:                    { id: 34,   title: "Dryer" },
  smoke_alarm:              { id: 35,   title: "Smoke alarm" },
  carbon_monoxide_alarm:    { id: 36,   title: "Carbon monoxide alarm" },
  hair_dryer:               { id: 45,   title: "Hair dryer" },
  iron:                     { id: 46,   title: "Iron" },
  dedicated_workspace:      { id: 47,   title: "Dedicated workspace" },
  self_check_in:            { id: 51,   title: "Self check-in" },
  tv:                       { id: 58,   title: "TV" },
  ev_charger:               { id: 97,   title: "EV charger" },
  bbq_grill:                { id: 99,   title: "BBQ grill" },
  step_free_access:         { id: 110,  title: "Step-free access" },
  wide_guest_entrance:      { id: 111,  title: "Guest entrance wider than 32 inches" },
  disabled_parking:         { id: 114,  title: "Disabled parking spot" },
  step_free_bedroom:        { id: 115,  title: "Step-free bedroom access" },
  wide_bedroom_entrance:    { id: 116,  title: "Bedroom entrance wider than 32 inches" },
  step_free_bathroom:       { id: 120,  title: "Step-free bathroom access" },
  wide_bathroom_entrance:   { id: 121,  title: "Bathroom entrance wider than 32 inches" },
  crib:                     { id: 286,  title: "Crib" },
  ceiling_or_mobile_hoist:  { id: 291,  title: "Ceiling or mobile hoist" },
  shower_grab_bar:          { id: 294,  title: "Shower grab bar" },
  toilet_grab_bar:          { id: 295,  title: "Toilet grab bar" },
  step_free_shower:         { id: 296,  title: "Step-free shower" },
  shower_or_bath_chair:     { id: 297,  title: "Shower or bath chair" },
  king_bed:                 { id: 1000, title: "King bed" },
};

// Airbnb's "Type of place" filter. This used to be sent as l2_property_type_ids,
// which is actually the building-type filter below (1 = House, 2 = Guesthouse,
// 3 = Apartment), so private_room returned guesthouses and shared_room apartments.
// The website no longer offers shared rooms, and Airbnb ignores room_types=Shared room.
const PLACE_TYPE_PARAMS: Record<string, [string, string]> = {
  entire_home:  ["room_types[]", "Entire home/apt"],
  private_room: ["room_types[]", "Private room"],
  hotel_room:   ["kg_and_tags[]", "Tag:9613"],
};

// Airbnb's "Property type" filter. Values of l2_property_type_ids combine with OR.
// The website sends Hotel as kg_and_tags[]=Tag:9613, but tags combine with AND, so
// "hotel or apartment" would return nothing; l2 type 4 is hotels and ORs cleanly.
const BUILDING_TYPE_PARAMS: Record<string, [string, string]> = {
  house:      ["l2_property_type_ids[]", "1"],
  guesthouse: ["l2_property_type_ids[]", "2"],
  apartment:  ["l2_property_type_ids[]", "3"],
  hotel:      ["l2_property_type_ids[]", "4"],
};

// Language codes from the "Host language" section of Airbnb's filter panel.
const HOST_LANGUAGES = [
  "af", "ar", "bg", "ca", "cs", "da", "de", "el", "en", "es", "eu", "fa", "fi", "fil",
  "fr", "gl", "he", "hi", "hr", "hu", "id", "it", "ja", "km", "ko", "lo", "ms", "nl",
  "no", "pa", "pl", "pt", "ro", "ru", "sgn", "sk", "sv", "sw", "te", "th", "tl", "tr",
  "uk", "vi", "zh",
];

// Tool definitions
const AIRBNB_SEARCH_TOOL: Tool = {
  name: "airbnb_search",
  description: "Search for Airbnb listings with various filters and pagination. Provide direct links to the user",
  inputSchema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "Location to search for (city, state, etc.)"
      },
      placeId: {
        type: "string",
        description: "Google Maps Place ID (overrides the location parameter)"
      },
      checkin: {
        type: "string",
        description: "Check-in date (YYYY-MM-DD)"
      },
      checkout: {
        type: "string",
        description: "Check-out date (YYYY-MM-DD)"
      },
      adults: {
        type: "number",
        description: "Number of adults"
      },
      children: {
        type: "number",
        description: "Number of children"
      },
      infants: {
        type: "number",
        description: "Number of infants"
      },
      pets: {
        type: "number",
        description: "Number of pets"
      },
      minPrice: {
        type: "number",
        description: "Minimum price for the stay"
      },
      maxPrice: {
        type: "number",
        description: "Maximum price for the stay"
      },
      cursor: {
        type: "string",
        description: "Base64-encoded string used for Pagination"
      },
      propertyType: {
        type: "string",
        enum: Object.keys(PLACE_TYPE_PARAMS),
        description: "Filter by type of place: 'entire_home' (entire homes/apartments), 'private_room' (private rooms in shared homes), 'hotel_room' (hotel rooms)"
      },
      buildingTypes: {
        type: "array",
        items: {
          type: "string",
          enum: Object.keys(BUILDING_TYPE_PARAMS)
        },
        description: "Filter by kind of building (Airbnb's 'Property type' filter). Listings matching any of these are returned"
      },
      minBedrooms: {
        type: "number",
        description: "Minimum number of bedrooms"
      },
      minBeds: {
        type: "number",
        description: "Minimum number of beds"
      },
      minBathrooms: {
        type: "number",
        description: "Minimum number of bathrooms"
      },
      amenities: {
        type: "array",
        items: {
          type: "string",
          enum: Object.keys(AMENITY_IDS)
        },
        description: "Only return listings that have all of these amenities. Each result's requestedAmenities lists the ones Airbnb confirms for it"
      },
      privateBathroom: {
        type: "boolean",
        description: "Only return listings with a private attached bathroom"
      },
      instantBook: {
        type: "boolean",
        description: "Only return listings that can be booked instantly, without waiting for host approval"
      },
      guestFavorite: {
        type: "boolean",
        description: "Only return 'Guest favorite' listings, Airbnb's most-loved homes by ratings and reviews"
      },
      luxe: {
        type: "boolean",
        description: "Only return Airbnb Luxe listings (luxury homes with a trip designer)"
      },
      superhost: {
        type: "boolean",
        description: "Only return listings whose host is a Superhost"
      },
      minReviewScore: {
        type: "number",
        description: "Minimum average guest rating, from 0 to 5 (e.g. 4.8). Airbnb applies it loosely: slightly lower-rated and unrated new listings can still appear"
      },
      hostLanguages: {
        type: "array",
        items: {
          type: "string",
          enum: HOST_LANGUAGES
        },
        description: "Only return listings whose host speaks one of these languages (language codes, e.g. 'en', 'ja'; 'sgn' is sign language)"
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Ignore robots.txt rules for this request"
      }
    },
    required: ["location"]
  }
};

const AIRBNB_LISTING_DETAILS_TOOL: Tool = {
  name: "airbnb_listing_details",
  description: "Get detailed information about a specific Airbnb listing. Provide direct links to the user",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The Airbnb listing ID"
      },
      checkin: {
        type: "string",
        description: "Check-in date (YYYY-MM-DD)"
      },
      checkout: {
        type: "string",
        description: "Check-out date (YYYY-MM-DD)"
      },
      adults: {
        type: "number",
        description: "Number of adults"
      },
      children: {
        type: "number",
        description: "Number of children"
      },
      infants: {
        type: "number",
        description: "Number of infants"
      },
      pets: {
        type: "number",
        description: "Number of pets"
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Ignore robots.txt rules for this request"
      }
    },
    required: ["id"]
  }
};

const AIRBNB_TOOLS = [
  AIRBNB_SEARCH_TOOL,
  AIRBNB_LISTING_DETAILS_TOOL,
] as const;

// Utility functions
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BASE_URL = "https://www.airbnb.com";

// Geocode location using Photon (fast, no rate limits) with Nominatim fallback.
// This bypasses Airbnb's broken server-side geocoding for non-US locations.
// Photon doesn't rank by importance, so we fetch multiple results and prefer
// cities/states/countries over hamlets/houses/POIs.
const PHOTON_TYPE_PRIORITY: Record<string, number> = {
  country: 1, state: 2, county: 3, city: 4, district: 5,
  locality: 6, street: 7, house: 8, other: 9,
};

function pickBestPhotonFeature(features: any[]): any | null {
  // Pick the feature with the highest-priority type (city > hamlet > house etc).
  // Don't filter by extent here — the best match (e.g. Stockholm, Sweden) may
  // lack an extent, and we'll fall back to Nominatim for the bbox.
  if (!features || features.length === 0) return null;

  return features.reduce((best: any, f: any) => {
    const bestPri = PHOTON_TYPE_PRIORITY[best.properties?.type] ?? PHOTON_TYPE_PRIORITY.other;
    const fPri = PHOTON_TYPE_PRIORITY[f.properties?.type] ?? PHOTON_TYPE_PRIORITY.other;
    return fPri < bestPri ? f : best;
  });
}

async function geocodeLocation(location: string): Promise<{
  ne_lat: string; ne_lng: string; sw_lat: string; sw_lng: string;
  displayName: string;
} | null> {
  let extent: number[] | null = null;
  let displayName = location;

  // Try Photon first — fast, no strict rate limits, OSM data.
  try {
    log('info', 'Geocoding location via Photon', { location });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(location)}&limit=5`;
    let response;
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": `mcp-server-airbnb/${VERSION} (+https://github.com/openbnb-org/mcp-server-airbnb)`,
          "Accept": "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.ok) {
      const data = await response.json() as any;
      const feature = pickBestPhotonFeature(data?.features ?? []);
      if (feature) {
        if (feature.properties?.extent?.length === 4) {
          extent = feature.properties.extent; // [west_lng, north_lat, east_lng, south_lat]
        }
        displayName = feature.properties?.name || location;
        log('info', 'Photon selected feature', {
          location,
          type: feature.properties?.type,
          name: feature.properties?.name,
          country: feature.properties?.country,
          hasExtent: !!extent,
        });
      }
    }
  } catch (error) {
    log('warn', 'Photon geocoding failed', {
      location,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Fall back to Nominatim if Photon didn't return a bbox.
  // Nominatim ranks by importance so it handles ambiguous names well.
  // Nominatim usage policy requires an identifying User-Agent (not a browser UA).
  // See https://operations.osmfoundation.org/policies/nominatim/
  if (!extent) {
    try {
      log('info', 'Falling back to Nominatim for geocoding', { location });
      const nomController = new AbortController();
      const nomTimeout = setTimeout(() => nomController.abort(), 5000);
      const nomUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
      let nomResponse;
      try {
        nomResponse = await fetch(nomUrl, {
          headers: {
            "User-Agent": `mcp-server-airbnb/${VERSION} (+https://github.com/openbnb-org/mcp-server-airbnb)`,
            "Accept": "application/json",
          },
          signal: nomController.signal,
        });
      } finally {
        clearTimeout(nomTimeout);
      }
      if (nomResponse.ok) {
        const nomResults = await nomResponse.json() as any[];
        if (nomResults?.[0]?.boundingbox?.length === 4) {
          const bb = nomResults[0].boundingbox; // [south_lat, north_lat, west_lng, east_lng]
          extent = [parseFloat(bb[2]), parseFloat(bb[1]), parseFloat(bb[3]), parseFloat(bb[0])];
          displayName = nomResults[0].display_name?.split(",")?.[0] || location;
          log('info', 'Nominatim fallback succeeded', { location, extent });
        }
      }
    } catch (nomError) {
      log('warn', 'Nominatim fallback also failed', { location });
    }
  }

  if (!extent || extent.length !== 4) {
    log('warn', 'No bounding box from either geocoder', { location });
    return null;
  }

  // Expand bounding box by 25% in each direction (minimum 0.1°, ~11km)
  // to capture suburbs, beaches, and surrounding areas. OSM returns tight
  // administrative boundaries (e.g., Paris = just the arrondissements,
  // Pensacola = city limits without the beach on the barrier island).
  const swLat = extent[3];
  const neLat = extent[1];
  const swLng = extent[0];
  const neLng = extent[2];
  const latPadding = Math.max((neLat - swLat) * 0.25, 0.1);
  const lngPadding = Math.max((neLng - swLng) * 0.25, 0.1);

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

  const coords = {
    sw_lat: clamp(swLat - latPadding, -90, 90).toFixed(7),
    ne_lat: clamp(neLat + latPadding, -90, 90).toFixed(7),
    sw_lng: clamp(swLng - lngPadding, -180, 180).toFixed(7),
    ne_lng: clamp(neLng + lngPadding, -180, 180).toFixed(7),
    displayName,
  };

  log('info', 'Geocoded successfully (with 25% padding)', { location, coords });
  return coords;
}


// Configuration from environment variables (set by DXT host)
const IGNORE_ROBOTS_TXT = process.env.IGNORE_ROBOTS_TXT === "true" || process.argv.slice(2).includes("--ignore-robots-txt");
// When true, skip the Photon/Nominatim geocoding step and let Airbnb's own
// server-side geocoder handle the location string. Defaults to false so the
// fix for non-US locations stays on by default; users who want zero third-party
// outbound calls can opt out by setting DISABLE_GEOCODING=true.
const DISABLE_GEOCODING = process.env.DISABLE_GEOCODING === "true";

const robotsErrorMessage = "This path is disallowed by Airbnb's robots.txt to this User-agent. You may or may not want to run the server with '--ignore-robots-txt' args"
let robotsTxtContent = "";

// Enhanced robots.txt fetch with timeout and error handling
async function fetchRobotsTxt() {
  if (IGNORE_ROBOTS_TXT) {
    log('info', 'Skipping robots.txt fetch (ignored by configuration)');
    return;
  }

  try {
    log('info', 'Fetching robots.txt from Airbnb');
    
    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    const response = await fetch(`${BASE_URL}/robots.txt`, {
      headers: {
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    robotsTxtContent = await response.text();
    log('info', 'Successfully fetched robots.txt');
  } catch (error) {
    log('warn', 'Error fetching robots.txt, assuming all paths allowed', {
      error: error instanceof Error ? error.message : String(error)
    });
    robotsTxtContent = ""; // Empty robots.txt means everything is allowed
  }
}

function isPathAllowed(path: string): boolean {  
  if (!robotsTxtContent) {
    return true; // If we couldn't fetch robots.txt, assume allowed
  }

  try {
    const robots = robotsParser(`${BASE_URL}/robots.txt`, robotsTxtContent);
    const allowed = robots.isAllowed(path, USER_AGENT);
    
    if (!allowed) {
      log('warn', 'Path disallowed by robots.txt', { path, userAgent: USER_AGENT });
    }
    
    return allowed;
  } catch (error) {
    log('warn', 'Error parsing robots.txt, allowing path', {
      path,
      error: error instanceof Error ? error.message : String(error)
    });
    return true; // If parsing fails, be permissive
  }
}

async function fetchWithUserAgent(url: string, timeout: number = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    
    throw error;
  }
}

// API handlers
async function handleAirbnbSearch(params: any) {
  const {
    location,
    placeId,
    checkin,
    checkout,
    adults = 1,
    children = 0,
    infants = 0,
    pets = 0,
    minPrice,
    maxPrice,
    cursor,
    propertyType,
    buildingTypes,
    minBedrooms,
    minBeds,
    minBathrooms,
    amenities,
    privateBathroom,
    instantBook,
    guestFavorite,
    luxe,
    superhost,
    minReviewScore,
    hostLanguages,
    ignoreRobotsText = false,
  } = params;

  // Resolve named filter values up front so a typo fails loudly instead of silently
  // widening the search. Accept "Hot tub" / "hot-tub" as well as "hot_tub".
  const invalid: Record<string, { unknown: string[]; valid: string[] }> = {};
  const resolveNames = (field: string, value: any, valid: string[]): string[] => {
    if (value == null) return [];
    const keys: string[] = [];
    const unknown: string[] = [];
    for (const name of Array.isArray(value) ? value : [value]) {
      const key = String(name).trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (!valid.includes(key)) unknown.push(String(name));
      else if (!keys.includes(key)) keys.push(key);
    }
    if (unknown.length) invalid[field] = { unknown, valid };
    return keys;
  };

  const placeTypeKeys = resolveNames("propertyType", propertyType, Object.keys(PLACE_TYPE_PARAMS));
  const buildingTypeKeys = resolveNames("buildingTypes", buildingTypes, Object.keys(BUILDING_TYPE_PARAMS));
  const requestedAmenityKeys = resolveNames("amenities", amenities, Object.keys(AMENITY_IDS));
  const hostLanguageKeys = resolveNames("hostLanguages", hostLanguages, HOST_LANGUAGES);

  if (Object.keys(invalid).length) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "Unknown filter values: " + Object.entries(invalid)
            .map(([field, { unknown }]) => `${field} (${unknown.join(", ")})`)
            .join("; "),
          validValues: Object.fromEntries(Object.entries(invalid).map(([field, { valid }]) => [field, valid]))
        }, null, 2)
      }],
      isError: true
    };
  }

  // Build search URL
  // Airbnb path segments use "--" as the separator (e.g. "Paris--France"),
  // not URL-encoded punctuation.  encodeURIComponent turns commas into %2C
  // which confuses Airbnb's geocoder (e.g. Paris → Barneville-Carteret).
  const slug = location
    .replace(/,\s*/g, "--")   // "Paris, France" → "Paris--France"
    .replace(/\s+/g, "-");    // remaining spaces → single dash
  const searchUrl = new URL(`${BASE_URL}/s/${encodeURIComponent(slug)}/homes`);
  
  // Add placeId
  if (placeId) searchUrl.searchParams.append("place_id", placeId);
  
  // Geocode and add bounding box to fix broken server-side geocoding.
  // Skipped when placeId is supplied (Airbnb's place lookup is reliable for those)
  // or when DISABLE_GEOCODING=true (user opt-out from third-party calls).
  if (!placeId && !DISABLE_GEOCODING) {
    const coords = await geocodeLocation(location);
    if (coords) {
      searchUrl.searchParams.append("ne_lat", coords.ne_lat);
      searchUrl.searchParams.append("ne_lng", coords.ne_lng);
      searchUrl.searchParams.append("sw_lat", coords.sw_lat);
      searchUrl.searchParams.append("sw_lng", coords.sw_lng);
    }
  }
  
  // Add query parameters
  if (checkin) searchUrl.searchParams.append("checkin", checkin);
  if (checkout) searchUrl.searchParams.append("checkout", checkout);
  
  // Add guests
  const adults_int = parseInt(adults.toString());
  const children_int = parseInt(children.toString());
  const infants_int = parseInt(infants.toString());
  const pets_int = parseInt(pets.toString());
  
  const totalGuests = adults_int + children_int;
  if (totalGuests > 0) {
    searchUrl.searchParams.append("adults", adults_int.toString());
    searchUrl.searchParams.append("children", children_int.toString());
    searchUrl.searchParams.append("infants", infants_int.toString());
    searchUrl.searchParams.append("pets", pets_int.toString());
  }
  
  // Add price range
  if (minPrice != null) searchUrl.searchParams.append("price_min", minPrice.toString());
  if (maxPrice != null) searchUrl.searchParams.append("price_max", maxPrice.toString());
  
  // Filters share parameters (propertyType hotel_room and some amenities both go out
  // as kg_and_tags[]), so skip values already on the URL rather than sending duplicates.
  const appendOnce = (name: string, value: string) => {
    if (!searchUrl.searchParams.getAll(name).includes(value)) searchUrl.searchParams.append(name, value);
  };

  // Add place and building type filters
  for (const key of placeTypeKeys) appendOnce(...PLACE_TYPE_PARAMS[key]);
  for (const key of buildingTypeKeys) appendOnce(...BUILDING_TYPE_PARAMS[key]);

  // Add rooms and beds minimums
  const minimums: [string, any][] = [
    ["min_bedrooms", minBedrooms],
    ["min_beds", minBeds],
    ["min_bathrooms", minBathrooms],
  ];
  for (const [name, value] of minimums) {
    const n = value == null ? 0 : parseInt(value.toString());
    if (n > 0) searchUrl.searchParams.append(name, n.toString());
  }

  // Add amenity filters
  for (const key of requestedAmenityKeys) {
    const { id, tag } = AMENITY_IDS[key];
    if (tag) appendOnce("kg_and_tags[]", tag);
    else appendOnce("amenities[]", String(id));
  }
  if (privateBathroom) searchUrl.searchParams.append("bathroom_privacy[]", "ENSUITE");

  // Add booking and standout-stay filters
  if (instantBook) searchUrl.searchParams.append("ib", "true");
  if (guestFavorite) searchUrl.searchParams.append("guest_favorite", "true");
  if (luxe) searchUrl.searchParams.append("tier_ids[]", "2");

  // Not in the website's filter panel, but Airbnb's search honors both.
  if (superhost) searchUrl.searchParams.append("superhost", "true");
  if (minReviewScore != null) {
    const score = parseFloat(minReviewScore.toString());
    if (score > 0) searchUrl.searchParams.append("min_review_score", Math.min(score, 5).toString());
  }

  // Add host language filter
  for (const code of hostLanguageKeys) searchUrl.searchParams.append("host_languages[]", code);

  // Add cursor for pagination
  if (cursor) {
    searchUrl.searchParams.append("cursor", cursor);
  }

  // Check if path is allowed by robots.txt
  const path = searchUrl.pathname + searchUrl.search;
  if (!ignoreRobotsText && !isPathAllowed(path)) {
    log('warn', 'Search blocked by robots.txt', { path, url: searchUrl.toString() });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: robotsErrorMessage,
          url: searchUrl.toString(),
          suggestion: "Consider enabling 'ignore_robots_txt' in extension settings if needed for testing"
        }, null, 2)
      }],
      isError: true
    };
  }

  const allowSearchResultSchema: Record<string, any> = {
    demandStayListing : {
      id: true,
      description: true,
      location: true,
    },
    badges: {
      text: true,
    },
    structuredContent: {
      mapCategoryInfo: {
        body: true
      },
      mapSecondaryLine: {
        body: true
      },
      primaryLine: {
        body: true
      },
      secondaryLine: {
        body: true
      },
    },
    avgRatingA11yLabel: true,
    listingParamOverrides: true,
    structuredDisplayPrice: {
      primaryLine: {
        accessibilityLabel: true,
      },
      secondaryLine: {
        accessibilityLabel: true,
      },
      explanationData: {
        title: true,
        priceDetails: {
          items: {
            description: true,
            priceString: true
          }
        }
      }
    },
    // contextualPictures: {
    //   picture: true
    // }
  };

  // When results run thin Airbnb relaxes amenity filters per listing and reports the
  // dropped IDs in listingParamOverrides.relaxedAmenityIds. Only the amenities that
  // were not relaxed are guaranteed, so claim those and name the rest separately
  // rather than asserting an amenity the listing may not have.
  const amenityMatch = (raw: any) => {
    if (!requestedAmenityKeys.length) return {};
    const relaxedIds = new Set(
      (raw?.listingParamOverrides?.relaxedAmenityIds ?? []).map((v: any) => Number(v))
    );
    const requested: string[] = [];
    const relaxed: string[] = [];
    for (const key of requestedAmenityKeys) {
      const { id, title } = AMENITY_IDS[key];
      (relaxedIds.has(id) ? relaxed : requested).push(title);
    }
    return {
      requestedAmenities: requested,
      ...(relaxed.length ? { relaxedAmenities: relaxed } : {}),
    };
  };

  try {
    log('info', 'Performing Airbnb search', { location, checkin, checkout, adults, children });
    
    const response = await fetchWithUserAgent(searchUrl.toString());
    const html = await response.text();
    const $ = cheerio.load(html);
    
    let staysSearchResults: any = {};
    let scriptContent = '';
    
    try {
      const scriptElement = $("#data-deferred-state-0").first();
      if (scriptElement.length === 0) {
        throw new Error("Could not find data script element - page structure may have changed");
      }
      
      scriptContent = $(scriptElement).text();
      if (!scriptContent) {
        throw new Error("Data script element is empty");
      }
      
      const clientData = JSON.parse(scriptContent);
      const results = clientData.niobeClientData[0][1].data.presentation.staysSearch.results;
      cleanObject(results);
      
      staysSearchResults = {
        searchResults: results.searchResults
          .map((raw: any) => {
            const result = flattenArraysInObject(pickBySchema(raw, allowSearchResultSchema));
            const id = atob(result.demandStayListing.id).split(":")[1];
            return { id, url: `${BASE_URL}/rooms/${id}`, ...amenityMatch(raw), ...result };
          }),
        paginationInfo: results.paginationInfo
      }
      
      log('info', 'Search completed successfully', { 
        resultCount: staysSearchResults.searchResults?.length || 0 
      });
    } catch (parseError) {
      let parsedRaw: any = null;
      try { parsedRaw = JSON.parse(scriptContent); } catch (_) {}
      const searchPath = ['niobeClientData', '0', '1', 'data', 'presentation', 'staysSearch', 'results'];
      const diagnosis = parsedRaw ? diagnoseJsonPath(parsedRaw, searchPath) : 'Could not parse script content as JSON';

      log('error', 'Failed to parse search results', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        diagnosis,
        url: searchUrl.toString()
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Failed to parse search results from Airbnb. The page structure may have changed.",
            details: parseError instanceof Error ? parseError.message : String(parseError),
            diagnosis,
            searchUrl: searchUrl.toString()
          }, null, 2)
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          searchUrl: searchUrl.toString(),
          ...staysSearchResults
        }, null, 2)
      }],
      isError: false
    };
  } catch (error) {
    log('error', 'Search request failed', {
      error: error instanceof Error ? error.message : String(error),
      url: searchUrl.toString()
    });
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          searchUrl: searchUrl.toString(),
          timestamp: new Date().toISOString()
        }, null, 2)
      }],
      isError: true
    };
  }
}

async function handleAirbnbListingDetails(params: any) {
  const {
    id,
    checkin,
    checkout,
    adults = 1,
    children = 0,
    infants = 0,
    pets = 0,
    ignoreRobotsText = false,
  } = params;

  // Build listing URL
  const listingUrl = new URL(`${BASE_URL}/rooms/${id}`);
  
  // Add query parameters
  if (checkin) listingUrl.searchParams.append("check_in", checkin);
  if (checkout) listingUrl.searchParams.append("check_out", checkout);
  
  // Add guests
  const adults_int = parseInt(adults.toString());
  const children_int = parseInt(children.toString());
  const infants_int = parseInt(infants.toString());
  const pets_int = parseInt(pets.toString());
  
  const totalGuests = adults_int + children_int;
  if (totalGuests > 0) {
    listingUrl.searchParams.append("adults", adults_int.toString());
    listingUrl.searchParams.append("children", children_int.toString());
    listingUrl.searchParams.append("infants", infants_int.toString());
    listingUrl.searchParams.append("pets", pets_int.toString());
  }

  // Check if path is allowed by robots.txt
  const path = listingUrl.pathname + listingUrl.search;
  if (!ignoreRobotsText && !isPathAllowed(path)) {
    log('warn', 'Listing details blocked by robots.txt', { path, url: listingUrl.toString() });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: robotsErrorMessage,
          url: listingUrl.toString(),
          suggestion: "Consider enabling 'ignore_robots_txt' in extension settings if needed for testing"
        }, null, 2)
      }],
      isError: true
    };
  }

  const allowSectionSchema: Record<string, any> = {
    "LOCATION_DEFAULT": {
      lat: true,
      lng: true,
      subtitle: true,
      title: true
    },
    "POLICIES_DEFAULT": {
      title: true,
      houseRulesSections: {
        title: true,
        items : {
          title: true
        }
      }
    },
    "HIGHLIGHTS_DEFAULT": {
      highlights: {
        title: true
      }
    },
    "DESCRIPTION_DEFAULT": {
      htmlDescription: {
        htmlText: true
      }
    },
    "AMENITIES_DEFAULT": {
      title: true,
      seeAllAmenitiesGroups: {
        title: true,
        amenities: {
          title: true
        }
      }
    },
    //"AVAILABLITY_CALENDAR_DEFAULT": true,
  };

  try {
    log('info', 'Fetching listing details', { id, checkin, checkout, adults, children });
    
    const response = await fetchWithUserAgent(listingUrl.toString());
    const html = await response.text();
    const $ = cheerio.load(html);
    
    // Always an array. A consumer doing details.find(...) should never meet an object.
    let details: any[] = [];
    let scriptContent = '';
    
    try {
      const scriptElement = $("#data-deferred-state-0").first();
      if (scriptElement.length === 0) {
        throw new Error("Could not find data script element - page structure may have changed");
      }
      
      scriptContent = $(scriptElement).text();
      if (!scriptContent) {
        throw new Error("Data script element is empty");
      }
      
      const clientData = JSON.parse(scriptContent);
      const sections = clientData.niobeClientData[0][1].data.presentation.stayProductDetailPage.sections.sections;
      sections.forEach((section: any) => cleanObject(section));
      
      let extracted: any[] = sections
        .filter((section: any) => allowSectionSchema.hasOwnProperty(section.sectionId))
        .map((section: any) => {
          return {
            id: section.sectionId,
            ...flattenArraysInObject(keyAmenityGroups(pickBySchema(section.section, allowSectionSchema[section.sectionId])))
          }
        });

      // Fill in the sections Airbnb now renders client-side.
      //
      // Substitute only when the content key this section exists to carry is actually
      // absent. Counting keys would be fragile in the direction that loses data: if
      // Airbnb ever adds one placeholder key to a stub, a count-based test would decide
      // the section was populated and silently discard the recovered content.
      const pdp = findPdpPresentation(clientData);
      const recovered: string[] = [];
      if (pdp) {
        const fromPdp: Record<string, { value: any | null; contentKey: string }> = {
          AMENITIES_DEFAULT: { value: extractAmenities(pdp), contentKey: "seeAllAmenitiesGroups" },
          HIGHLIGHTS_DEFAULT: { value: extractHighlights(pdp), contentKey: "highlights" },
        };

        extracted = extracted.map((section: any) => {
          const replacement = fromPdp[section.id];
          if (replacement?.value && !section[replacement.contentKey]) {
            recovered.push(section.id);
            // Merge onto the section rather than replacing it. A stub can be partial —
            // carrying a title while missing the content — and rebuilding from `id`
            // alone would throw away whatever the section tree did manage to supply.
            return { ...section, ...flattenArraysInObject(keyAmenityGroups(replacement.value)) };
          }
          return section;
        });

        // Also cover the case where the stub is dropped from the section list entirely.
        for (const [sectionId, replacement] of Object.entries(fromPdp)) {
          if (replacement.value && !extracted.some((s: any) => s.id === sectionId)) {
            recovered.push(sectionId);
            extracted.push({ id: sectionId, ...flattenArraysInObject(keyAmenityGroups(replacement.value)) });
          }
        }
      }

      details = extracted;

      log('info', 'Listing details fetched successfully', {
        id,
        sectionsFound: extracted.length,
        recoveredFromPdpPresentation: recovered.length ? recovered : undefined
      });
    } catch (parseError) {
      let parsedRaw: any = null;
      try { parsedRaw = JSON.parse(scriptContent); } catch (_) {}
      const detailsPath = ['niobeClientData', '0', '1', 'data', 'presentation', 'stayProductDetailPage', 'sections', 'sections'];
      const diagnosis = parsedRaw ? diagnoseJsonPath(parsedRaw, detailsPath) : 'Could not parse script content as JSON';

      log('error', 'Failed to parse listing details', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        diagnosis,
        id,
        url: listingUrl.toString()
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Failed to parse listing details from Airbnb. The page structure may have changed.",
            details: parseError instanceof Error ? parseError.message : String(parseError),
            diagnosis,
            listingUrl: listingUrl.toString()
          }, null, 2)
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          listingUrl: listingUrl.toString(),
          details: details
        }, null, 2)
      }],
      isError: false
    };
  } catch (error) {
    log('error', 'Listing details request failed', {
      error: error instanceof Error ? error.message : String(error),
      id,
      url: listingUrl.toString()
    });
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          listingUrl: listingUrl.toString(),
          timestamp: new Date().toISOString()
        }, null, 2)
      }],
      isError: true
    };
  }
}

// Server setup
const server = new Server(
  {
    name: "airbnb",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Enhanced logging for DXT
function log(level: 'info' | 'warn' | 'error', message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  
  if (data) {
    console.error(`${logMessage}:`, JSON.stringify(data, null, 2));
  } else {
    console.error(logMessage);
  }
}

log('info', 'Airbnb MCP Server starting', {
  version: VERSION,
  ignoreRobotsTxt: IGNORE_ROBOTS_TXT,
  disableGeocoding: DISABLE_GEOCODING,
  nodeVersion: process.version,
  platform: process.platform
});

// Set up request handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: AIRBNB_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const startTime = Date.now();
  
  try {
    // Validate request parameters
    if (!request.params.name) {
      throw new McpError(ErrorCode.InvalidParams, "Tool name is required");
    }
    
    if (!request.params.arguments) {
      throw new McpError(ErrorCode.InvalidParams, "Tool arguments are required");
    }
    
    log('info', 'Tool call received', { 
      tool: request.params.name,
      arguments: request.params.arguments 
    });
    
    // Ensure robots.txt is loaded
    if (!robotsTxtContent && !IGNORE_ROBOTS_TXT) {
      await fetchRobotsTxt();
    }

    let result;
    switch (request.params.name) {
      case "airbnb_search": {
        result = await handleAirbnbSearch(request.params.arguments);
        break;
      }

      case "airbnb_listing_details": {
        result = await handleAirbnbListingDetails(request.params.arguments);
        break;
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
    }
    
    const duration = Date.now() - startTime;
    log('info', 'Tool call completed', { 
      tool: request.params.name, 
      duration: `${duration}ms`,
      success: !result.isError 
    });
    
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    log('error', 'Tool call failed', {
      tool: request.params.name,
      duration: `${duration}ms`,
      error: error instanceof Error ? error.message : String(error)
    });
    
    if (error instanceof McpError) {
      throw error;
    }
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString()
        }, null, 2)
      }],
      isError: true
    };
  }
});

async function runServer() {
  try {
    // Initialize robots.txt on startup
    await fetchRobotsTxt();
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    log('info', 'Airbnb MCP Server running on stdio', {
      version: VERSION,
      robotsRespected: !IGNORE_ROBOTS_TXT
    });
    
    // Graceful shutdown handling
    process.on('SIGINT', () => {
      log('info', 'Received SIGINT, shutting down gracefully');
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      log('info', 'Received SIGTERM, shutting down gracefully');
      process.exit(0);
    });
    
  } catch (error) {
    log('error', 'Failed to start server', {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  }
}

runServer().catch((error) => {
  log('error', 'Fatal error running server', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
