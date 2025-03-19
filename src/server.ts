import express from 'express';
import {Server} from 'http';
import {McpServer, ResourceTemplate, ListResourcesCallback} from "@modelcontextprotocol/sdk/server/mcp.js";
import {TextContent, ListResourcesResult} from "@modelcontextprotocol/sdk/types.js";

import {SSEServerTransport} from "@modelcontextprotocol/sdk/server/sse.js";
import {z} from "zod";

import multer from 'multer';
import {getUploadsDir} from './utils/paths';
import path from 'path';
import * as fs from "node:fs";

import {openFile, readWindow, injectWindow, describeWindow, listWindows, listFiles} from './main';

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
export function startMcp(port: number): SseServer {

    const app = express();

    // Middleware to parse JSON
    app.use(express.json({limit: '50mb'})); // Increased limit for larger files

    const mcpServer = new McpServer({
        name: "PopUI",
        version: "1.0.0"
    });

    mcpServer.tool(
        "pop-ui",
        "This tool allows the host to create and display a shared user interface that can serve as a visual context layer for the conversation.\n" +
        "This tool allows the host to move beyond text-only interactions to create, collaborative experiences like games, visualization tools, control panels, " +
        "and other interactive interfaces where both parties can manipulate a shared visual context.\n" +
        "Once a user interface is shown, subsequent pop-ui tool calls in 'get' mode should be used to update the context state.",
        {
            name: z.string().describe(
                "The name of the user interface.\n" +
                "This name will be used to reference the user interface in all modes.\n" +
                "This parameter is required."
            ),
            mode: z.enum(["show", "get", "set", "describe"]).optional().describe(
                "The mode of operation for the user interface. Use:" +
                "'show' to show a user interface (create/update by passing tsx or show an existing from ui://list)\n" +
                "'get' to read the current model state of a user interface\n" +
                "'set' to inject a model state into a user interface\n" +
                "'describe' to get the schema of the json model object."
            ),
            json: z.string().optional().describe(
                "The json model object to set the initial or updated state of the user interface. Valid for modes 'set' and 'show'."
            ),
            tsx: z.string().optional().describe(
                "A react component to display in the electron BrowserWindow.\n" +
                "This component must be compatible with dynamic loading via babel.\n" +
                "This component is a single reference and must be entirely self contained.\n" +
                "This component must set a function 'window.getState()' to get the current state of the user interface as a detailed json model object.\n" +
                "This component must set a function 'window.setState(json)' to set the current state of the user interface.\n" +
                "This component must set a function 'window.describeState()' to get the schema of the json model object.\n" +
                "This component can send messages to the host with 'window.api.sendToHost(text)'.\n" +
                "- Use this method with submit buttons and action elements to automatically send messages on behalf of the user\n" +
                "- For interactive elements like buttons, forms, and selectors, implement 'sendToHost' in the onClick/onSubmit handlers to communicate user selections back to the conversation\n" +
                "- When a user performs an action in the UI, use 'window.api.sendToHost(text)' to reflect that action in the conversation context without requiring the user to type a response\n" +
                "- Example: A \"Submit\" button should call 'window.api.sendToHost(\"Form submitted with value: \" + value)' to automatically send the form result\n" +
                "- User interfaces like forms or games should have explicit buttons at the bottom for the user to indicate submission.\n" +
                "This component should have preferred dimensions in its element styling.\n" +
                "This component should use tailwindcss for good styling and alignment.\n" +
                "This component should use unicode emoji or lucide-react for icons, including empty space icons.\n" +
                "This component should use appropriate widgets for ranges, enumerations, and other selectable data.\n" +
                "This component may be updated with subsequent calls to pop-ui in 'set' mode.\n"
            ),
        },
        async ({name, mode, json, tsx}) => {
            const fileName = `${name}.tsx`;
            const filePath = path.join(uploadsDir, fileName);

            if (mode === "show") {
                let windowState = await readWindow(name as string);

                if (tsx === undefined && windowState === null) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `tsx is required when mode is show and window does not exist.`
                            } as TextContent
                        ],
                        isError: true
                    }
                }
                
                if (tsx !== undefined) {
                    //Save the tsx file to the uploads directory
                    await fs.promises.writeFile(filePath, tsx);
                    
                    mcpServer.server.notification({
                        method: "notifications/resources/list_changed",
                    });
                }
                else if (json !== undefined) {
                    windowState = await injectWindow(name as string, json as string);
                }
                
                openFile(filePath);

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
            if (mode === "set") {
                const windowState = await injectWindow(name as string, json as string);

                if (windowState === null) {
                    //Error: window not found
                    return {
                        content: [
                            {
                                type: "text",
                                text: `User interface named "${name}" not found.`
                            } as TextContent
                        ],
                        isError: true
                    }
                }

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
            if (mode === "get") {
                //Save the tsx file to the uploads directory
                const windowState = await readWindow(name as string);

                if (windowState === null) {
                    //Error: window not found
                    return {
                        content: [
                            {
                                type: "text",
                                text: `User interface named "${name}" not found.`
                            } as TextContent
                        ],
                        isError: true
                    }
                }

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
            if (mode === "describe") {
                //Save the tsx file to the uploads directory
                const windowState = await describeWindow(name as string);

                if (windowState === null) {
                    //Error: window not found
                    return {
                        content: [
                            {
                                type: "text",
                                text: `User interface named "${name}" not found.`
                            } as TextContent
                        ],
                        isError: true
                    }
                }

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

            //Return invalid mode
            return {
                content: [
                    {
                        type: "text",
                        text: `Invalid mode "${mode}".`
                    } as TextContent
                ],
                isError: true
            }
        }
    );

    mcpServer.resource(
        "ui/list",
        "ui://list",
        async (uri) => {
            const files = await listFiles();
            //Convert to a json array of .tsx filenames without extensions
            const windowNames = files
                .filter(fileName => path.extname(fileName) === '.tsx')
                .map(fileName => path.basename(fileName, '.tsx'));

            return {
                contents: [{
                    uri: uri.href,
                    text: `${JSON.stringify(windowNames, null, 2)}`
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
            console.log("Received POST to /messages", req.body);

            // Check if we have any connections first
            if (transports.size === 0) {
                return res.status(503).json({error: "No active SSE connections"});
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
                const transport: SSEServerTransport = transports.get(sessionId);
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
            res.status(500).json({error: error});
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