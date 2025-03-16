import express from 'express';
import {Server} from 'http';
import {McpServer, ResourceTemplate, ListResourcesCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import {TextContent, ListResourcesResult } from "@modelcontextprotocol/sdk/types.js";

import {SSEServerTransport} from "@modelcontextprotocol/sdk/server/sse.js";
import {z} from "zod";

import multer from 'multer';
import {getUploadsDir} from './utils/paths';
import path from 'path';
import * as fs from "node:fs";

import {openFile, readWindow, listWindows } from './main';

let serverInstance: Server | null = null;

export interface SseServer {
    server: Server;
    transports: Map<string, SSEServerTransport> | null;
    mcp: McpServer;
}

// Set up uploads directory
const uploadsDir = getUploadsDir();
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, {recursive: true});
}

export function startServer(port: number): Server {
    const app = express();

    // Middleware to parse JSON
    app.use(express.json({limit: '50mb'})); // Increased limit for larger files

    // Basic route
    app.get('/api/hello', (req, res) => {
        res.json({message: 'Hello from the server!'});
    });

    app.get('/api/files', (req, res) => {
        try {
            const files = fs.readdirSync(uploadsDir)
                .filter(fileName => path.extname(fileName) === '.tsx')
                .map(fileName => ({
                    name: fileName,
                    path: path.join(uploadsDir, fileName),
                    size: fs.statSync(path.join(uploadsDir, fileName)).size
                }));
            res.json({files: files});
        } catch (error) {
            res.status(500).json({error: 'Could not read upload directory'});
        }
    });

    // File upload endpoint that handles direct file data instead of using multer
    app.post('/upload', async (req, res) => {
        try {
            // Check if we have the required data
            if (!req.body.fileName || !req.body.fileData) {
                return res.status(400).json({error: 'Missing file data or file name'});
            }

            const {fileName, fileType, fileSize, fileData} = req.body;

            // Create a safe filename
            const sanitizedFileName = path.basename(fileName);
            const filePath = path.join(uploadsDir, sanitizedFileName);

            // Convert array back to Buffer
            const fileBuffer = Buffer.from(fileData);

            // Write file to disk
            fs.writeFileSync(filePath, fileBuffer);

            // Return success response
            res.status(200).json({
                success: true,
                message: 'File uploaded successfully',
                file: {
                    originalName: fileName,
                    size: fileSize,
                    type: fileType,
                    path: filePath
                }
            });
        } catch (error) {
            console.error('Error handling file upload:', error);
            res.status(500).json({error: 'Failed to process file upload', details: String(error)});
        }
    });

    // For traditional multipart form uploads, keep multer as an option
    const upload = multer({dest: uploadsDir});
    app.post('/upload-form', upload.single('file'), (req, res) => {
        if (!req.file) {
            return res.status(400).json({error: 'No file uploaded'});
        }

        res.status(200).json({
            success: true,
            message: 'File uploaded successfully',
            file: {
                originalName: req.file.originalname,
                size: req.file.size,
                path: req.file.path
            }
        });
    });

    // Start the server
    serverInstance = app.listen(port, () => {
        console.log(`Server is running at http://localhost:${port}`);
    });

    return serverInstance;
}

//Get an SSE McpServer
export function startMcp(port: number) : SseServer {

    const app = express();

    // Middleware to parse JSON
    app.use(express.json({limit: '50mb'})); // Increased limit for larger files

    const mcpServer = new McpServer({
        name: "PopToggle",
        version: "1.0.0"
    });

    mcpServer.tool(
        "pop-ui",
        "Use this tool to create and display an interactive user interface or control panel.\n" +
        "The tool will display a react component in an electron BrowserWindow passed in via the tsx parameter.\n" +
        "The react component should set a function 'window.getState()' to get the current state of the user interface as a detailed json model object.\n" +
        "The react component should have good styling and alignment for an electron app UI.\n" +
        "The react component should use appropriate widgets for ranges, enumerations, and other selectable data.\n" +
        "The tool will respond with the name of the instantiated user interface.\n" +
        "Use the read-ui://${name} resource to retrieve the current user interface data and state.",
        {
            name: z.string(),
            tsx: z.string(),
        },
        async ({name, tsx}) => {
            //Save the tsx file to the uploads directory
            const fileName = `${name}.tsx`;
            const filePath = path.join(uploadsDir, fileName);

            await fs.promises.writeFile(filePath, tsx);
            //Signal the app to open the file
            openFile(filePath);

            mcpServer.server.notification({
                method: "notifications/resources/list_changed",
            });
            
            return {
                content: [
                    {
                        type: "text",
                        text: `User interface named "${name}" created and shown. Use read-ui://${name} to retrieve the user interface data and state.`
                    } as TextContent
                ],
                isError: false
            }
        }
    );
    
    //Hack to get claude to read the data. Resources don't seem to work.
    mcpServer.tool(
      "read-ui",
      "This tool will read an open user interface created by the pop-ui tool.",
        {
            name: z.string(),
        },
        async ({name}) => {
            //Save the tsx file to the uploads directory
            const windowState = await readWindow(name as string);

            return {
                content: [
                    {
                        type: "text",
                        text: `${windowState}`
                    } as TextContent
                ],
                isError: false
            }
        }
    );

    const listResourcesCallback: ListResourcesCallback = (extra): ListResourcesResult => {
        // Get all window names from the windows Map
        const windowNames = listWindows();

        // Convert them to resources in the required format
        const resources = windowNames.map(windowName => {
            return {
                uri: "read-ui://" + windowName,
                id: windowName,
                name: windowName, // You could enhance this with more descriptive names if needed
                type: 'window',    // Specify the type as 'window'
                // Add any other required properties based on the resource schema
                metadata: {
                    createdAt: new Date().toISOString(),
                    // Add any other metadata you'd like to include
                }
            };
        });

        return {
            resources: resources
        };
    };
    
    mcpServer.resource(
        "read-ui",
        new ResourceTemplate("read-ui://{name}", { list: listResourcesCallback }),
        async (uri, { name }) => {
            const windowState = await readWindow(name as string);
            
            return {
                contents: [{
                    uri: uri.href,
                    text: `${windowState}`
                }]
            }
        }
    );

    const transports = new Map();

    app.get("/sse", async (req, res) => {
        // Create new transport for this connection
        const transport = new SSEServerTransport("/messages", res);

        // Store it in the map using the session ID that's created in the constructor
        transports.set(transport.sessionId, transport);

        // Handle connection close
        res.on('close', () => {
            transports.delete(transport.sessionId);
            console.log(`Connection ${transport.sessionId} closed`);
        });

        // Connect to MCP server
        await mcpServer.connect(transport);

        // Log the session ID for debugging
        console.log(`New SSE connection established with session ID: ${transport.sessionId}`);
    });

    app.post("/messages", async (req, res) => {
        try {
            // Debug logging to see what's being received
            console.log("Received POST to /messages", {
                body: req.body,
                headers: req.headers
            });

            // Check if we have any connections first
            if (transports.size === 0) {
                return res.status(503).json({ error: "No active SSE connections" });
            }

            // Try to get sessionId from various possible locations
            let sessionId = null;

            // 1. Check if it's in the body
            if (req.body && req.body.sessionId) {
                sessionId = req.body.sessionId;
            }
            // 2. Check if it's in a custom header
            else if (req.headers['x-session-id']) {
                sessionId = req.headers['x-session-id'];
            }
            // 3. Check if it's in the URL query parameters
            else if (req.query.sessionId) {
                sessionId = req.query.sessionId;
            }

            const parsedBody = req.body;

            // If we found a sessionId and it exists in our connections
            if (sessionId && transports.has(sessionId)) {
                console.log(`Using specified session ID: ${sessionId}`);
                const transport : SSEServerTransport = transports.get(sessionId);
                await transport.handlePostMessage(req, res, parsedBody);
            }
            // Otherwise, use the first available connection
            else {
                console.log("No valid session ID found, using first available connection");
                const [firstSessionId, transport] = [...transports.entries()][0];
                console.log(`Using first available session ID: ${firstSessionId}`);
                await transport.handlePostMessage(req, res, parsedBody);
            }
        } catch (error) {
            console.error("Error handling POST message:", error);
            res.status(500).json({ error: error });
        }
    });

    // Start the server
    serverInstance = app.listen(port, () => {
        console.log(`Server is running at http://localhost:${port}`);
    });
    
    return {
        server: serverInstance, 
        transports: transports,
        mcp: mcpServer
    };
}