import BugReport from "../models/BugReport.js";

// Helper to determine initial repo
function determineTargetRepo(category, componentType) {
  if (category === "component" || (componentType && componentType.trim().length > 0)) {
    return "emulator";
  }
  if (category === "compiler_backend") {
    return "backend";
  }
  return "frontend";
}

/**
 * Create a new Bug Report or Feature Request (Public)
 */
export const createBugReport = async (req, res) => {
  try {
    const {
      title,
      description,
      type = "bug",
      category = "general",
      componentType = "",
      componentLabel = "",
      failingFeatures = [],
      codeSnippet = "",
      stepsToReproduce = "",
      expectedBehavior = "",
      browserInfo = "",
      osInfo = "",
      reporterEmail = "",
      reporterName = "Anonymous",
      rating = 5,
      userRole = "Maker",
      attachmentUrl = "",
    } = req.body;

    if (!title || !description) {
      return res.status(400).json({ error: "Title and description are required." });
    }

    const reportType = ["bug", "feature", "review"].includes(type) ? type : "bug";

    // Enforce authentication for Reviews and Feature Requests
    if (reportType === "review" || reportType === "feature") {
      if (!req.user) {
        return res.status(401).json({
          error: `Please sign in to submit a ${reportType === "review" ? "review" : "feature request"}.`,
        });
      }
    }

    const targetRepo = determineTargetRepo(category, componentType);

    const bug = new BugReport({
      title: title.trim(),
      description: description.trim(),
      type: ["bug", "feature", "review"].includes(type) ? type : "bug",
      rating: Math.min(5, Math.max(1, Number(rating) || 5)),
      userRole: String(userRole || "Maker").trim(),
      category,
      componentType: componentType.trim(),
      componentLabel: componentLabel.trim(),
      failingFeatures: Array.isArray(failingFeatures) ? failingFeatures : [],
      codeSnippet: String(codeSnippet || ""),
      stepsToReproduce: String(stepsToReproduce || ""),
      expectedBehavior: String(expectedBehavior || ""),
      attachmentUrl: String(attachmentUrl || "").trim(),
      browserInfo: String(browserInfo || ""),
      osInfo: String(osInfo || ""),
      reporterEmail: req.user?.email || String(reporterEmail || "").trim(),
      reporterName: req.user?.name || String(reporterName || "").trim() || "Anonymous",
      targetRepo,
      status: "under_review",
    });

    await bug.save();

    res.status(201).json({
      success: true,
      message: "Feedback submitted successfully!",
      id: bug._id,
    });
  } catch (error) {
    console.error("Error creating bug report:", error);
    res.status(500).json({ error: "Failed to submit feedback." });
  }
};

/**
 * Get Public List of Bug Reports / Features (Sanitized)
 */
export const getPublicBugReports = async (req, res) => {
  try {
    const { type, status, category, search } = req.query;
    const filter = {};

    if (type && type !== "all") {
      filter.type = type;
    }
    if (status && status !== "all") {
      filter.status = status;
    }
    if (category && category !== "all") {
      filter.category = category;
    }
    if (search && search.trim().length > 0) {
      const q = search.trim();
      filter.$or = [
        { title: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
        { componentLabel: { $regex: q, $options: "i" } },
        { componentType: { $regex: q, $options: "i" } },
      ];
    }

    // Client IP for upvote state
    const clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket.remoteAddress ||
      "unknown";

    const items = await BugReport.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // Sanitize private emails from public view
    const sanitized = items.map((item) => ({
      _id: item._id,
      title: item.title,
      description: item.description,
      type: item.type,
      rating: item.rating || 5,
      userRole: item.userRole || "Maker",
      category: item.category,
      componentType: item.componentType,
      componentLabel: item.componentLabel,
      failingFeatures: item.failingFeatures,
      codeSnippet: item.codeSnippet,
      stepsToReproduce: item.stepsToReproduce,
      expectedBehavior: item.expectedBehavior,
      browserInfo: item.browserInfo,
      osInfo: item.osInfo,
      reporterName: item.reporterName,
      status: item.status,
      targetRepo: item.targetRepo,
      upvotes: item.upvotes || 0,
      hasUpvoted: (item.upvotedIps || []).includes(clientIp),
      downvotes: item.downvotes || 0,
      hasDownvoted: (item.downvotedIps || []).includes(clientIp),
      comments: item.comments || [],
      githubIssueUrl: item.githubIssueUrl,
      adminNotes: item.adminNotes,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));

    res.json({ success: true, count: sanitized.length, items: sanitized });
  } catch (error) {
    console.error("Error fetching public bug reports:", error);
    res.status(500).json({ error: "Failed to fetch bug reports." });
  }
};

/**
 * Toggle Upvote on a Bug / Feature (Public)
 */
export const toggleUpvote = async (req, res) => {
  try {
    const { id } = req.params;
    const clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket.remoteAddress ||
      "unknown";

    const bug = await BugReport.findById(id);
    if (!bug) {
      return res.status(404).json({ error: "Report not found." });
    }

    const ipIndex = bug.upvotedIps.indexOf(clientIp);
    let hasUpvoted = false;

    if (ipIndex > -1) {
      // Remove upvote
      bug.upvotedIps.splice(ipIndex, 1);
      bug.upvotes = Math.max(0, bug.upvotes - 1);
      hasUpvoted = false;
    } else {
      // Add upvote & remove downvote if previously downvoted
      bug.upvotedIps.push(clientIp);
      bug.upvotes += 1;
      hasUpvoted = true;

      const downIndex = (bug.downvotedIps || []).indexOf(clientIp);
      if (downIndex > -1) {
        bug.downvotedIps.splice(downIndex, 1);
        bug.downvotes = Math.max(0, (bug.downvotes || 1) - 1);
      }
    }

    await bug.save();

    res.json({
      success: true,
      upvotes: bug.upvotes,
      hasUpvoted,
      downvotes: bug.downvotes || 0,
      hasDownvoted: (bug.downvotedIps || []).includes(clientIp),
    });
  } catch (error) {
    console.error("Error toggling upvote:", error);
    res.status(500).json({ error: "Failed to toggle upvote." });
  }
};

/**
 * Toggle Downvote on a Bug / Feature (Public)
 */
export const toggleDownvote = async (req, res) => {
  try {
    const { id } = req.params;
    const clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket.remoteAddress ||
      "unknown";

    const bug = await BugReport.findById(id);
    if (!bug) {
      return res.status(404).json({ error: "Report not found." });
    }

    if (!bug.downvotedIps) bug.downvotedIps = [];
    const ipIndex = bug.downvotedIps.indexOf(clientIp);
    let hasDownvoted = false;

    if (ipIndex > -1) {
      // Remove downvote
      bug.downvotedIps.splice(ipIndex, 1);
      bug.downvotes = Math.max(0, (bug.downvotes || 1) - 1);
      hasDownvoted = false;
    } else {
      // Add downvote & remove upvote if previously upvoted
      bug.downvotedIps.push(clientIp);
      bug.downvotes = (bug.downvotes || 0) + 1;
      hasDownvoted = true;

      const upIndex = (bug.upvotedIps || []).indexOf(clientIp);
      if (upIndex > -1) {
        bug.upvotedIps.splice(upIndex, 1);
        bug.upvotes = Math.max(0, (bug.upvotes || 1) - 1);
      }
    }

    await bug.save();

    res.json({
      success: true,
      downvotes: bug.downvotes || 0,
      hasDownvoted,
      upvotes: bug.upvotes || 0,
      hasUpvoted: (bug.upvotedIps || []).includes(clientIp),
    });
  } catch (error) {
    console.error("Error toggling downvote:", error);
    res.status(500).json({ error: "Failed to toggle downvote." });
  }
};

/**
 * Add Admin Comment to a Bug Report / Feature (Admin only)
 */
export const addAdminComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Comment text is required." });
    }

    const bug = await BugReport.findById(id);
    if (!bug) {
      return res.status(404).json({ error: "Report not found." });
    }

    const newComment = {
      authorName: req.user?.name || "Admin Staff",
      authorEmail: req.user?.email || "",
      text: text.trim(),
      createdAt: new Date(),
    };

    if (!bug.comments) bug.comments = [];
    bug.comments.push(newComment);
    await bug.save();

    res.json({
      success: true,
      comments: bug.comments,
      comment: newComment,
    });
  } catch (error) {
    console.error("Error adding admin comment:", error);
    res.status(500).json({ error: "Failed to add admin comment." });
  }
};

/**
 * Admin Update (Status, Target Repo, Notes, GitHub URL)
 */
export const updateBugReportAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, targetRepo, adminNotes, githubIssueUrl } = req.body;

    const updates = {};
    if (status) updates.status = status;
    if (targetRepo) updates.targetRepo = targetRepo;
    if (adminNotes !== undefined) updates.adminNotes = adminNotes;
    if (githubIssueUrl !== undefined) updates.githubIssueUrl = githubIssueUrl;

    const updated = await BugReport.findByIdAndUpdate(id, updates, {
      new: true,
    });

    if (!updated) {
      return res.status(404).json({ error: "Report not found." });
    }

    res.json({ success: true, item: updated });
  } catch (error) {
    console.error("Error updating bug report:", error);
    res.status(500).json({ error: "Failed to update report." });
  }
};

/**
 * Admin Delete
 */
export const deleteBugReportAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await BugReport.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ error: "Report not found." });
    }
    res.json({ success: true, message: "Report deleted successfully." });
  } catch (error) {
    console.error("Error deleting bug report:", error);
    res.status(500).json({ error: "Failed to delete report." });
  }
};
