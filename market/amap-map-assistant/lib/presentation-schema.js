import { MAX_INSTRUCTIONS, MAX_PLACES, MAX_WAYPOINTS, SCHEMA_VERSION, SOURCE_TOOLS, TOOL_NAME, presentationSummary } from './protocol.js'

const coordinateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['longitude', 'latitude'],
  properties: {
    longitude: { type: 'number', minimum: 72, maximum: 136 },
    latitude: { type: 'number', minimum: 0, maximum: 54 }
  }
}

const placeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'location'],
  properties: {
    id: { type: 'string', maxLength: 160 },
    name: { type: 'string', maxLength: 160 },
    address: { type: 'string', maxLength: 400 },
    type: { type: 'string', maxLength: 120 },
    location: coordinateSchema
  }
}

const summarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    distanceMeters: { type: 'number', minimum: 0 },
    durationSeconds: { type: 'number', minimum: 0 },
    costCny: { type: 'number', minimum: 0 },
    walkingDistanceMeters: { type: 'number', minimum: 0 },
    transfers: { type: 'integer', minimum: 0 },
    instructions: { type: 'array', maxItems: MAX_INSTRUCTIONS, items: { type: 'string', maxLength: 500 } }
  }
}

export const presentationParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'scene', 'title', 'sourceTools'],
  properties: {
    schemaVersion: { type: 'integer', const: SCHEMA_VERSION },
    scene: { type: 'string', enum: ['route', 'places', 'location'] },
    title: { type: 'string', maxLength: 240 },
    origin: placeSchema,
    destination: placeSchema,
    waypoints: { type: 'array', maxItems: MAX_WAYPOINTS, items: placeSchema },
    mode: { type: 'string', enum: ['driving', 'transit', 'walking', 'bicycling'] },
    places: { type: 'array', minItems: 1, maxItems: MAX_PLACES, items: placeSchema },
    summary: summarySchema,
    sourceTools: {
      type: 'array',
      minItems: 1,
      maxItems: SOURCE_TOOLS.size,
      uniqueItems: true,
      items: { type: 'string', enum: [...SOURCE_TOOLS] }
    },
    fetchedAt: { type: 'string', maxLength: 80 }
  }
}

export const presentationOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'kind', 'presentation', 'presentationMeta'],
  properties: {
    schemaVersion: { type: 'integer', const: SCHEMA_VERSION },
    kind: { type: 'string', const: 'amap-presentation' },
    presentation: { type: 'object', additionalProperties: true },
    presentationMeta: { type: 'object', additionalProperties: true }
  }
}

export function presentationMeta(presentation) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'amap-presentation',
    id: presentation.id,
    sessionId: presentation.sessionId,
    scene: presentation.scene,
    title: presentation.title,
    revision: presentation.revision,
    presentation,
    summary: presentationSummary(presentation),
    tool: TOOL_NAME
  }
}

export function renderPresentation(_args, value) {
  const presentation = value?.presentation
  return [{
    type: 'text',
    text: presentation ? presentationSummary(presentation) : '地图展示已提交。'
  }]
}
