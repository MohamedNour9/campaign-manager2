// Static OpenAPI spec — no swagger-jsdoc needed (avoids ESM/CJS compatibility issues)
export const swaggerSpec = {
  openapi: '3.0.0',
  info: { title: 'Email Campaign Manager API', version: '1.0.0' },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      RegisterRequest: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' } } },
      LoginRequest: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' } } },
      AccountRequest: { type: 'object', properties: { providerType: { type: 'string', enum: ['smtp', 'brevo', 'ses', 'mailgun', 'sendgrid'] }, name: { type: 'string' }, config: { type: 'object' } } },
      CampaignRequest: { type: 'object', properties: { name: { type: 'string' }, subject: { type: 'string' }, senderName: { type: 'string' }, htmlContent: { type: 'string' }, textContent: { type: 'string' } } },
    },
  },
  paths: {
    '/api/auth/register': { post: { summary: 'Register a new user', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisterRequest' } } } }, responses: { '200': { description: 'User registered' } } } },
    '/api/auth/login': { post: { summary: 'Log in', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } } }, responses: { '200': { description: 'Login successful' } } } },
    '/api/accounts': {
      get: { summary: 'List sending accounts', security: [{ bearerAuth: [] }], responses: { '200': { description: 'OK' } } },
      post: { summary: 'Add a sending account', security: [{ bearerAuth: [] }], requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/AccountRequest' } } } }, responses: { '201': { description: 'Account created' } } },
    },
    '/api/accounts/{id}': { delete: { summary: 'Delete a sending account', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' } } } },
    '/api/upload': { post: { summary: 'Upload a recipient list (CSV/TXT)', security: [{ bearerAuth: [] }], responses: { '200': { description: 'OK' } } } },
    '/api/campaigns': {
      get: { summary: 'List campaigns', security: [{ bearerAuth: [] }], responses: { '200': { description: 'OK' } } },
      post: { summary: 'Create a campaign', security: [{ bearerAuth: [] }], requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/CampaignRequest' } } } }, responses: { '201': { description: 'Campaign created' } } },
    },
    '/api/campaigns/{id}/start': { post: { summary: 'Start sending a campaign', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Campaign started' } } } },
    '/api/campaigns/{id}/pause': { post: { summary: 'Pause a campaign', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Campaign paused' } } } },
    '/api/campaigns/{id}/stats': { get: { summary: 'Get campaign stats', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Stats' } } } },
  },
};
