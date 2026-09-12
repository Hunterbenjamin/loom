// zod boundary for Python reuse of spike 02's polling and hook-file harness.
import {z} from 'zod';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const record=z.record(z.string(),z.unknown());
const schemas={
 agents:z.array(z.object({sessionId:z.string().nullish(),pid:z.number().int().positive().optional(),cwd:z.string().optional(),status:z.string().optional()}).passthrough()),
 hooks:z.array(z.object({recv_ms:z.number(),body:z.object({session_id:z.string().uuid(),hook_event_name:z.string(),cwd:z.string(),prompt:z.string().optional(),prompt_id:z.string().optional(),transcript_path:z.string().optional()}).passthrough()}).passthrough()),
 transcripts:z.array(record),
 panes:z.array(z.object({pane:z.string().regex(/^%\d+$/),window:z.string(),pid:z.number().int().positive(),command:z.string(),cwd:z.string(),startPath:z.string(),dead:z.boolean(),exitStatus:z.string()})),
};
const schema=schemas[process.argv[2]];if(!schema)throw new Error('Unknown schema');
try{process.stdout.write(JSON.stringify(schema.parse(JSON.parse(Buffer.concat(chunks).toString()))));}
catch{console.error('Invalid external JSON');process.exitCode=1;}
