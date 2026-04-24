// Barrel for resume-service integration. At boot, construct an http client
// pointed at env.RESUME_BASE and thread it through getResumeByEmail.
export { getResumeByEmail } from './getResumeByEmail.js';
