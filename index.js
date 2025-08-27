#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { GoogleAdsApi } from 'google-ads-api';
import { google } from 'googleapis';
import fs from 'fs/promises';
import http from 'http';
import url from 'url';

class AutomatedTokenManager {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_ADS_CLIENT_ID,
      process.env.GOOGLE_ADS_CLIENT_SECRET,
      'https://google-ads-mcp-service-production.up.railway.app/auth/callback'
    );
    this.tokensFile = './tokens.json';
    this.tokens = null;
  }

  async initializeTokens() {
    try {
      if (process.env.GOOGLE_ADS_REFRESH_TOKEN) {
        this.tokens = {
          refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
          access_token: process.env.GOOGLE_ADS_ACCESS_TOKEN || null,
          expiry_date: process.env.GOOGLE_ADS_TOKEN_EXPIRY ? parseInt(process.env.GOOGLE_ADS_TOKEN_EXPIRY) : null
        };
        this.oauth2Client.setCredentials(this.tokens);
        console.log('Loaded tokens from environment variables');
        await this.ensureValidTokens();
        return;
      }

      try {
        const tokenData = await fs.readFile(this.tokensFile, 'utf8');
        this.tokens = JSON.parse(tokenData);
        this.oauth2Client.setCredentials(this.tokens);
        console.log('Loaded existing tokens from file');
        await this.ensureValidTokens();
        return;
      } catch (fileError) {
        console.log('No existing tokens found, need initial setup');
        await this.performInitialAuth();
      }
    } catch (error) {
      console.log('No existing tokens found, need initial setup');
      await this.performInitialAuth();
    }
  }

  async performInitialAuth() {
    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/adwords'],
      prompt: 'consent'
    });

    console.log('\n=== INITIAL SETUP REQUIRED ===');
    console.log('1. Visit this URL:', authUrl);
    console.log('2. Sign in and grant permissions');
    console.log('3. You will see a page with an authorization code');
    console.log('4. Copy that code and set it as INITIAL_AUTH_CODE environment variable');
    console.log('5. Restart the server');
    console.log('================================\n');

    if (process.env.INITIAL_AUTH_CODE) {
      const { tokens } = await this.oauth2Client.getToken(process.env.INITIAL_AUTH_CODE);
      await this.saveTokens(tokens);
      this.oauth2Client.setCredentials(tokens);
      console.log('Initial authentication complete!');
      console.log('Tokens saved to environment variables');
      console.log('You can now remove INITIAL_AUTH_CODE from environment variables');
    } else {
      throw new Error('Initial authentication required - check logs for setup instructions');
    }
  }

  async ensureValidTokens() {
    try {
      if (!this.tokens.access_token || this.isTokenExpiringSoon()) {
        console.log('Refreshing access token...');
        const { credentials } = await this.oauth2Client.refreshAccessToken();
        await this.saveTokens(credentials);
        this.oauth2Client.setCredentials(credentials);
        console.log('Tokens refreshed successfully');
      }
    } catch (error) {
      console.error('Token refresh failed:', error);
      throw new Error('Authentication failed - may need to re-authenticate');
    }
  }

  isTokenExpiringSoon() {
    if (!this.tokens.expiry_date) return true;
    const fiveMinutes = 5 * 60 * 1000;
    return (this.tokens.expiry_date - Date.now()) < fiveMinutes;
  }

  async saveTokens(tokens) {
    this.tokens = { ...this.tokens, ...tokens };
    await fs.writeFile(this.tokensFile, JSON.stringify(this.tokens, null, 2));
    
    if (this.tokens.refresh_token) {
      console.log('\nSAVE THESE TO RAILWAY ENVIRONMENT VARIABLES:');
      console.log(`GOOGLE_ADS_REFRESH_TOKEN=${this.tokens.refresh_token}`);
      if (this.tokens.access_token) {
        console.log(`GOOGLE_ADS_ACCESS_TOKEN=${this.tokens.access_token}`);
      }
      if (this.tokens.expiry_date) {
        console.log(`GOOGLE_ADS_TOKEN_EXPIRY=${this.tokens.expiry_date}`);
      }
      console.log('=================================\n');
    }
  }

  async getValidAccessToken() {
    await this.ensureValidTokens();
    return this.tokens.access_token;
  }
}

class GoogleAdsMCPServer {
  constructor() {
    this.server = new Server(
      { name: "google-ads-mcp-server", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );
    this.tokenManager = new AutomatedTokenManager();
    this.googleAdsApi = null;
    this.customer = null;
    this.setupToolHandlers();
  }

  async initializeGoogleAds() {
    try {
      console.log('Initializing Google Ads API...');
      await this.tokenManager.initializeTokens();
      
      this.googleAdsApi = new GoogleAdsApi({
        client_id: process.env.GOOGLE_ADS_CLIENT_ID,
        client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
        developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      });

      this.customer = this.googleAdsApi.Customer({
        customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID,
        refresh_token: this.tokenManager.tokens.refresh_token,
      });

      console.log('Google Ads API initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Google Ads API:', error);
      throw error;
    }
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "get_campaigns",
            description: "Get all campaigns from Google Ads account",
            inputSchema: {
              type: "object",
              properties: {
                customer_id: {
                  type: "string",
                  description: "Google Ads customer ID (optional, uses default if not provided)",
                },
              },
            },
          },
          {
            name: "get_campaign_metrics",
            description: "Get performance metrics for campaigns",
            inputSchema: {
              type: "object",
              properties: {
                campaign_id: {
                  type: "string",
                  description: "Campaign ID to get metrics for",
                },
                start_date: {
                  type: "string",
                  description: "Start date (YYYY-MM-DD format)",
                },
                end_date: {
                  type: "string",
                  description: "End date (YYYY-MM-DD format)",
                },
              },
              required: ["campaign_id", "start_date", "end_date"],
            },
          },
          {
            name: "test_connection",
            description: "Test the Google Ads API connection",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "test_connection":
            return await this.testConnection();
          case "get_campaigns":
            return await this.getCampaigns(args?.customer_id);
          case "get_campaign_metrics":
            return await this.getCampaignMetrics(
              args.campaign_id,
              args.start_date,
              args.end_date
            );
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Error executing ${name}: ${error.message}`
        );
      }
    });
  }

  async testConnection() {
    try {
      if (!this.customer) {
        await this.initializeGoogleAds();
      }

      const result = await this.customer.query(`
        SELECT customer.id, customer.descriptive_name
        FROM customer
        LIMIT 1
      `);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "success",
              message: "Google Ads API connection successful",
              customer_info: result[0],
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              message: "Failed to connect to Google Ads API",
              error: error.message,
            }, null, 2),
          },
        ],
      };
    }
  }

  async getCampaigns(customerId = null) {
    try {
      if (!this.customer) {
        await this.initializeGoogleAds();
      }

      await this.tokenManager.ensureValidTokens();

      const query = `
        SELECT 
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.advertising_channel_type,
          campaign.start_date,
          campaign.end_date
        FROM campaign
        ORDER BY campaign.name
      `;

      const campaigns = await this.customer.query(query);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "success",
              count: campaigns.length,
              campaigns: campaigns,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw error;
    }
  }

  async getCampaignMetrics(campaignId, startDate, endDate) {
    try {
      if (!this.customer) {
        await this.initializeGoogleAds();
      }

      await this.tokenManager.ensureValidTokens();

      const query = `
        SELECT 
          campaign.id,
          campaign.name,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversion_rate,
          segments.date
        FROM campaign
        WHERE campaign.id = ${campaignId}
          AND segments.date BETWEEN '${startDate}' AND '${endDate}'
        ORDER BY segments.date DESC
      `;

      const metrics = await this.customer.query(query);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "success",
              campaign_id: campaignId,
              date_range: { start: startDate, end: endDate },
              metrics: metrics,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw error;
    }
  }

  startHttpServer() {
    const server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Last-Event-ID');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const parsedUrl = url.parse(req.url, true);

      try {
        if (req.method === 'GET' && parsedUrl.pathname === '/') {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({ 
            name: 'Google Ads MCP Server',
            status: 'running',
            version: '0.1.0',
            endpoints: {
              health: '/health',
              mcp: '/mcp',
              test: '/api/test',
              campaigns: '/api/campaigns'
            }
          }));
          return;
        }

        if (req.method === 'GET' && parsedUrl.pathname === '/health') {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok', message: 'Google Ads MCP Server is running' }));
          return;
        }

        if (parsedUrl.pathname === '/mcp') {
          await this.handleMCPEndpoint(req, res);
          return;
        }

        if (req.method === 'GET' && parsedUrl.pathname === '/api/test') {
          const result = await this.testConnection();
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(result.content[0].text);
          return;
        }

        if (req.method === 'GET' && parsedUrl.pathname === '/api/campaigns') {
          const result = await this.getCampaigns();
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(result.content[0].text);
          return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));

      } catch (error) {
        console.error('HTTP request error:', error);
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(500);
        res.end(JSON.stringify({ error: error.message }));
      }
    });

    const port = process.env.PORT || 8080;
    server.listen(port, () => {
      console.log(`HTTP server running on port ${port}`);
    });

    setInterval(() => {
      console.log(`Keep-alive ping: ${new Date().toISOString()}`);
    }, 60000);
  }

  async handleMCPEndpoint(req, res) {
    const sessionId = req.headers['mcp-session-id'];

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const message = JSON.parse(body);
          const response = await this.handleMCPMessage(message, sessionId);
          
          if (response.sessionId) {
            res.setHeader('Mcp-Session-Id', response.sessionId);
            delete response.sessionId;
          }

          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify(response));
        } catch (error) {
          console.error('MCP message error:', error);
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(500);
          res.end(JSON.stringify({ 
            jsonrpc: '2.0',
            error: { 
              code: -32603, 
              message: 'Internal error', 
              data: error.message 
            } 
          }));
        }
      });
    } else if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.writeHead(200);
      
      res.write('data: {"type":"ping"}\n\n');
      
      setTimeout(() => {
        res.end();
      }, 1000);
    } else if (req.method === 'DELETE' && sessionId) {
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(405);
      res.end();
    }
  }

  async handleMCPMessage(message, sessionId) {
    const { method, params, id } = message;

    try {
      if (method === 'initialize') {
        const newSessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'google-ads-mcp-server',
              version: '0.1.0',
            }
          },
          sessionId: newSessionId
        };
      }

      if (method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: "get_campaigns",
                description: "Get all campaigns from Google Ads account",
                inputSchema: {
                  type: "object",
                  properties: {
                    customer_id: {
                      type: "string",
                      description: "Google Ads customer ID (optional, uses default if not provided)",
                    },
                  },
                },
              },
              {
                name: "test_connection",
                description: "Test the Google Ads API connection",
                inputSchema: {
                  type: "object",
                  properties: {},
                },
              },
            ],
          }
        };
      }

      if (method === 'tools/call') {
        const { name, arguments: args } = params;
        let result;

        switch (name) {
          case "test_connection":
            result = await this.testConnection();
            break;
          case "get_campaigns":
            result = await this.getCampaigns(args?.customer_id);
            break;
          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          jsonrpc: '2.0',
          id,
          result
        };
      }

      throw new Error(`Unknown method: ${method}`);
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: 'Internal error',
          data: error.message
        }
      };
    }
  }

  async run() {
    try {
      await this.initializeGoogleAds();
    } catch (error) {
      console.error('Startup initialization failed:', error.message);
      console.log('Server will retry initialization on first tool call');
    }

    this.startHttpServer();

    process.on('SIGTERM', () => {
      console.log('Received SIGTERM, shutting down gracefully');
      process.exit(0);
    });

    process.on('SIGINT', () => {
      console.log('Received SIGINT, shutting down gracefully');
      process.exit(0);
    });

    console.error("Google Ads MCP server running on HTTP");
  }
}

const server = new GoogleAdsMCPServer();
server.run().catch(console.error);
