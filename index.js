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
      // Try to load tokens from environment variables (persistent)
      if (process.env.GOOGLE_ADS_REFRESH_TOKEN) {
        this.tokens = {
          refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
          access_token: process.env.GOOGLE_ADS_ACCESS_TOKEN || null,
          expiry_date: process.env.GOOGLE_ADS_TOKEN_EXPIRY ? parseInt(process.env.GOOGLE_ADS_TOKEN_EXPIRY) : null
        };
        this.oauth2Client.setCredentials(this.tokens);
        
        console.log('✅ Loaded tokens from environment variables');
        await this.ensureValidTokens();
        return;
      }

      // Fallback to file (temporary)
      try {
        const tokenData = await fs.readFile(this.tokensFile, 'utf8');
        this.tokens = JSON.parse(tokenData);
        this.oauth2Client.setCredentials(this.tokens);
        
        console.log('✅ Loaded existing tokens from file');
        await this.ensureValidTokens();
        return;
      } catch (fileError) {
        console.log('⚠️ No existing tokens found, need initial setup');
        await this.performInitialAuth();
      }
      
    } catch (error) {
      console.log('⚠️ No existing tokens found, need initial setup');
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
      console.log('🎉 Initial authentication complete!');
      console.log('💾 Tokens saved to environment variables');
      console.log('ℹ️ You can now remove INITIAL_AUTH_CODE from environment variables');
    } else {
      throw new Error('Initial authentication required - check logs for setup instructions');
    }
  }

  async ensureValidTokens() {
    try {
      if (!this.tokens.access_token || this.isTokenExpiringSoon()) {
        console.log('🔄 Refreshing access token...');
        const { credentials } = await this.oauth2Client.refreshAccessToken();
        await this.saveTokens(credentials);
        this.oauth2Client.setCredentials(credentials);
        console.log('✅ Tokens refreshed successfully');
      }
    } catch (error) {
      console.error('❌ Token refresh failed:', error);
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
    
    // Save to file (temporary - gets deleted on restart)
    await fs.writeFile(this.tokensFile, JSON.stringify(this.tokens, null, 2));
    
    // Also save to environment variables for persistence
    // Note: This only updates the current process, you need to manually add these to Railway
    if (this.tokens.refresh_token) {
      console.log('\n🔑 SAVE THESE TO RAILWAY ENVIRONMENT VARIABLES:');
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
      {
        name: "google-ads-mcp-server",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.tokenManager = new AutomatedTokenManager();
    this.googleAdsApi = null;
    this.customer = null;
    this.setupToolHandlers();
  }

  async initializeGoogleAds() {
    try {
      console.log('🔧 Initializing Google Ads API...');
      
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

      console.log('✅ Google Ads API initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize Google Ads API:', error);
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

  async run() {
    try {
      await this.initializeGoogleAds();
    } catch (error) {
      console.error('⚠️ Startup initialization failed:', error.message);
      console.log('📝 Server will retry initialization on first tool call');
    }

    // Start HTTP server for Claude Projects
    this.startHttpServer();

    console.error("🚀 Google Ads MCP server running on HTTP");
  }

  startHttpServer() {
    const server = http.createServer(async (req, res) => {
      // Enable CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const parsedUrl = url.parse(req.url, true);
      res.setHeader('Content-Type', 'application/json');

      try {
        if (req.method === 'GET' && parsedUrl.pathname === '/health') {
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok', message: 'Google Ads MCP Server is running' }));
        
        } else if (req.method === 'GET' && parsedUrl.pathname === '/api/test') {
          const result = await this.testConnection();
          res.writeHead(200);
          res.end(result.content[0].text);
        
        } else if (req.method === 'GET' && parsedUrl.pathname === '/api/campaigns') {
          const result = await this.getCampaigns();
          res.writeHead(200);
          res.end(result.content[0].text);
        
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      } catch (error) {
        console.error('HTTP request error:', error);
        res.writeHead(500);
        res.end(JSON.stringify({ error: error.message }));
      }
    });

    const port = process.env.PORT || 8080;
    server.listen(port, () => {
      console.log(`🌐 HTTP server running on port ${port}`);
    });
  }
}

const server = new GoogleAdsMCPServer();
server.run().catch(console.error);
