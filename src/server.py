import os
import json
import logging
from typing import Dict, Any, List
from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Google Ads MCP Service",
    description="Multi-tenant Google Ads MCP server for client services",
    version="1.0.0"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global client config
client_config = {}

@app.on_event("startup")
async def startup_event():
    """Load client configuration on startup"""
    global client_config
    try:
        config_path = os.getenv("CLIENT_CONFIG_PATH", "config/client_config.json")
        with open(config_path, 'r') as f:
            client_config = json.load(f)
        logger.info(f"Loaded configuration for {len(client_config.get('clients', {}))} clients")
    except FileNotFoundError:
        logger.error("Client config file not found")
        client_config = {"clients": {}}
    except Exception as e:
        logger.error(f"Error loading config: {e}")
        client_config = {"clients": {}}

@app.get("/")
async def root():
    """Health check endpoint"""
    return {
        "service": "Google Ads MCP Service",
        "status": "active",
        "clients": len(client_config.get('clients', {})),
        "version": "1.0.0"
    }

@app.get("/health")
async def health_check():
    """Health check for Railway"""
    return {"status": "healthy", "timestamp": "2025-01-01T00:00:00Z"}

# MCP Protocol Models
class MCPRequest(BaseModel):
    method: str
    params: Dict[str, Any] = {}

class MCPResponse(BaseModel):
    result: Any = None
    error: str = None

@app.post("/mcp/{client_id}")
async def mcp_endpoint(client_id: str, request: MCPRequest):
    """Main MCP endpoint for client requests"""
    
    # Validate client
    if client_id not in client_config.get('clients', {}):
        raise HTTPException(status_code=404, detail="Client not found")
    
    client_info = client_config['clients'][client_id]
    
    if not client_info.get('active', False):
        raise HTTPException(status_code=403, detail="Client account inactive")
    
    logger.info(f"MCP request from {client_id}: {request.method}")
    
    try:
        # Route MCP methods
        if request.method == "tools/list":
            return MCPResponse(result=await list_tools(client_id))
        elif request.method == "tools/call":
            return MCPResponse(result=await call_tool(client_id, request.params))
        else:
            raise HTTPException(status_code=400, detail=f"Unknown method: {request.method}")
            
    except Exception as e:
        logger.error(f"Error processing request: {e}")
        return MCPResponse(error=str(e))

async def list_tools(client_id: str) -> List[Dict]:
    """Return available tools for the client"""
    return [
        {
            "name": "list_accounts",
            "description": "List all Google Ads accounts",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        },
        {
            "name": "get_campaign_performance",
            "description": "Get campaign performance data",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "customer_id": {"type": "string", "description": "Google Ads customer ID"},
                    "date_range": {"type": "string", "description": "Date range (LAST_7_DAYS, LAST_30_DAYS, etc.)"}
                },
                "required": ["customer_id"]
            }
        }
    ]

async def call_tool(client_id: str, params: Dict[str, Any]) -> Dict:
    """Execute a tool call for the client"""
    tool_name = params.get("name")
    tool_args = params.get("arguments", {})
    
    client_info = client_config['clients'][client_id]
    
    if tool_name == "list_accounts":
        # Mock response for now
        return {
            "accounts": [
                {
                    "id": client_info['google_ads']['customer_id'],
                    "name": f"{client_info['name']} - Google Ads",
                    "status": "ACTIVE"
                }
            ]
        }
    
    elif tool_name == "get_campaign_performance":
        # Mock response for now - we'll implement real Google Ads API later
        return {
            "campaigns": [
                {
                    "id": "123456789",
                    "name": "Sample Campaign",
                    "status": "ENABLED",
                    "impressions": 10000,
                    "clicks": 500,
                    "ctr": 5.0,
                    "cost_micros": 50000000,
                    "conversions": 25
                }
            ],
            "client": client_info['name']
        }
    
    else:
        raise HTTPException(status_code=400, detail=f"Unknown tool: {tool_name}")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
