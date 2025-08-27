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
