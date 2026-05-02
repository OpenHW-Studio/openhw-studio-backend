import 'dotenv/config';

// GitHub API configuration
const GITHUB_TOKEN = process.env.GITHUB_ADMIN_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'your-github-username'; // Needs to be configured by user
const GITHUB_REPO_FRONTEND = process.env.GITHUB_REPO_FRONTEND || 'OpenHW-studio-frontend';
const GITHUB_REPO_BACKEND = process.env.GITHUB_REPO_BACKEND || 'openhw-studio-backend';

const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28'
};

/**
 * Fetch pending deployments and their preceding smoke test logs
 */
export const getPendingDeployments = async (req, res) => {
    if (!GITHUB_TOKEN) {
        return res.status(500).json({ error: 'GITHUB_ADMIN_TOKEN is not configured on the server.' });
    }

    try {
        const fetchRuns = async (repo) => {
            // Fetch workflow runs that are 'waiting'
            const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/runs?status=waiting`, { headers });
            
            if (!response.ok) {
                console.error(`GitHub API error for ${repo}:`, await response.text());
                return [];
            }

            const data = await response.json();
            
            // For each run, fetch its jobs to get test results
            const runsWithJobs = await Promise.all(data.workflow_runs.map(async (run) => {
                const jobsResponse = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/runs/${run.id}/jobs`, { headers });
                const jobsData = jobsResponse.ok ? await jobsResponse.json() : { jobs: [] };
                
                return {
                    id: run.id,
                    repo: repo,
                    name: run.name,
                    head_branch: run.head_branch,
                    head_commit: run.head_commit.message,
                    status: run.status,
                    created_at: run.created_at,
                    jobs: jobsData.jobs.map(job => ({
                        name: job.name,
                        status: job.status,
                        conclusion: job.conclusion,
                        html_url: job.html_url
                    }))
                };
            }));
            return runsWithJobs;
        };

        const frontendRuns = await fetchRuns(GITHUB_REPO_FRONTEND);
        const backendRuns = await fetchRuns(GITHUB_REPO_BACKEND);

        res.json({
            success: true,
            pending: [...frontendRuns, ...backendRuns]
        });

    } catch (error) {
        console.error('Error fetching deployments:', error);
        res.status(500).json({ error: 'Failed to fetch deployments from GitHub.' });
    }
};

/**
 * Approve a pending deployment
 */
export const approveDeployment = async (req, res) => {
    const { run_id, repo, environment } = req.body;

    if (!run_id || !repo || !environment) {
        return res.status(400).json({ error: 'run_id, repo, and environment are required.' });
    }

    try {
        // Find the pending deployment for the run
        const pendingResp = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/runs/${run_id}/pending_deployments`, { headers });
        
        if (!pendingResp.ok) {
            return res.status(500).json({ error: 'Failed to fetch pending deployment details.' });
        }

        const pendingData = await pendingResp.json();
        const envId = pendingData[0]?.environment?.id;

        if (!envId) {
            return res.status(404).json({ error: 'No pending deployment found for this run.' });
        }

        // Approve it
        const approveResp = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/runs/${run_id}/pending_deployments`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                environment_ids: [envId],
                state: 'approved',
                comment: 'Approved via Admin Dashboard'
            })
        });

        if (!approveResp.ok) {
            const err = await approveResp.text();
            console.error('Approval failed:', err);
            return res.status(500).json({ error: 'Failed to approve deployment on GitHub.', details: err });
        }

        res.json({ success: true, message: 'Deployment approved and started.' });

    } catch (error) {
        console.error('Error approving deployment:', error);
        res.status(500).json({ error: 'Internal server error during approval.' });
    }
};

let deploymentNotifications = [];

/**
 * Webhook endpoint for sub-repos to notify the backend of changes
 */
export const notifyChange = (req, res) => {
    const { repo, prTitle, prDescription, filesChanged } = req.body;
    
    if (!repo) {
        return res.status(400).json({ error: 'Repo name is required.' });
    }

    const newNotification = {
        id: Date.now().toString(),
        repo,
        prTitle: prTitle || 'Update detected',
        prDescription: prDescription || '',
        filesChanged: filesChanged || [],
        timestamp: new Date().toISOString()
    };

    deploymentNotifications.push(newNotification);
    res.json({ success: true, message: 'Notification received.' });
};

/**
 * Get pending sub-repo change notifications
 */
export const getNotifications = (req, res) => {
    res.json({ success: true, notifications: deploymentNotifications });
};

/**
 * Trigger a rebuild of the main repos from the dashboard
 */
export const triggerBuild = async (req, res) => {
    const { target_repo, notification_id } = req.body;

    if (!target_repo) {
        return res.status(400).json({ error: 'target_repo is required.' });
    }

    try {
        const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${target_repo}/actions/workflows/deploy.yml/dispatches`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: 'develop' })
        });

        if (!response.ok) {
            const err = await response.text();
            return res.status(500).json({ error: 'Failed to trigger build.', details: err });
        }

        // Clear notification if provided
        if (notification_id) {
            deploymentNotifications = deploymentNotifications.filter(n => n.id !== notification_id);
        }

        res.json({ success: true, message: `Build triggered for ${target_repo}. It will appear in pending deployments once tests pass.` });
    } catch (error) {
         console.error('Error triggering build:', error);
         res.status(500).json({ error: 'Internal server error.' });
    }
};

/**
 * Trigger a manual rollback to a specific Docker image tag
 */
export const rollbackDeployment = async (req, res) => {
    const { repo, image_tag } = req.body;
    
    if (!repo || !image_tag) {
        return res.status(400).json({ error: 'repo and image_tag are required.' });
    }
    
    try {
        const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/workflows/rollback.yml/dispatches`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ref: 'develop',
                inputs: {
                    image_tag: image_tag
                }
            })
        });

        if (!response.ok) {
            const err = await response.text();
            return res.status(500).json({ error: 'Failed to trigger rollback dispatch.', details: err });
        }

        res.json({ success: true, message: `Rollback triggered for ${repo} to tag ${image_tag}.` });
    } catch (error) {
         console.error('Error rolling back:', error);
         res.status(500).json({ error: 'Internal server error during rollback.' });
    }
};
