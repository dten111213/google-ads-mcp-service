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

class AutomatedTokenManager {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_ADS_CLIENT_ID,
      process.env.GOOGLE_ADS_CLIENT_SECRET,
      'urn:ietf:wg:oauth:2.0:oob' // For server-side apps
    );

    this.tokensFile = './tokens.json';
    this.tokens = null;
  }

  async initializeTokens() {
    try {
      // Try to load existing tokens
      const tokenData = await fs.readFile(this.tokensFile, 'utf8');
      this.tokens = JSON.parse(tokenData);
      this.oauth2Client.setCredentials(this.tokens);
      
      console.log('✅ Loaded existing tokens');
      
      // Check if tokens need refresh
      await this.ensureValidTokens();
      
    } catch (error) {
      console.log('⚠️ No existing tokens found, need initial setup');
      await this.performInitialAuth();
    }
  }

  async performInitialAuth() {
    // Generate auth URL - you only need to do this once manually
    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/adwords'],
      prompt: 'consent' // Forces refresh token generation
    });

    console.log('\n=== INITIAL SETUP REQUIRED ===');
    console.log('1. Visit this URL:', authUrl);
    console.log('2. Copy the code and set it as INITIAL_AUTH_CODE environment variable');
    console.log('3. Restart the server');
    console.log('================================\n');

    // Check if initial code is provided
    if (process.env.INITIAL_AUTH_CODE) {
      const { tokens } = await this.oauth2Client.getToken(process.env.INITIAL_AUTH_CODE);
      await this.saveTokens(tokens);
      this.oauth2Client.setCredentials(tokens);
      console.log('🎉 Initial authentication complete!');
      
      // Clear the auth code from environment for security
      console.log('ℹ️ You can now remove INITIAL_AUTH_CODE from environment variables');
    } else {
      throw new Error('Initial authentication required - check logs for setup instructions');
    }
  }

  async ensureValidTokens() {
    try {
      // Check if access token is expired or expires soon
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
    
    // Check if token expires in next 5 minutes
    const fiveMinutes = 5 * 60 * 1000;
    return (this.tokens.expiry_date - Date.now()) < fiveMinutes;
  }

  async saveTokens(tokens) {
    this.tokens = { ...this.tokens, ...tokens };
    await fs.writeFile(this.tokensFile, JSON.stringify(this.tokens, null, 2));
  }

  // Get current valid access token for Google Ads API
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
      
      // Initialize token manager first
      await this.tokenManager.initializeTokens();
      
      // Get fresh access token
      const accessToken = await this.tokenManager.getValidAccessToken();
      
      this.googleAdsApi = GoogleAdsApi({
        client_id: process.env.GOOGLE_ADS_CLIENT_ID,
        client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
        developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        access_token: accessToken,
      });

      // Create customer instance
      this.customer = this.googleAdsApi.Customer({
        customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID,
      });

      console.log('✅ Google Ads API initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize Google Ads API:', error);
      throw error;
    }
  }

  setupToolHandlers() {
    // List available tools
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
