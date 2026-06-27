import GlobalAdventureConfig from "../models/GlobalAdventureConfig.js";
import { resolveAdventureConfig, sanitizeAdventureContent } from "./classAdventureController.js";

const GLOBAL_KEY = "global";

export const getAdminGlobalAdventureConfig = async (req, res) => {
  try {
    const config = await GlobalAdventureConfig.findOne({ key: GLOBAL_KEY });
    const resolved = config ? resolveAdventureConfig(config) : null;
    return res.status(200).json({ config: resolved, resolved });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch global adventure config.", error: error.message });
  }
};

export const upsertAdminGlobalAdventureConfig = async (req, res) => {
  try {
    const content = sanitizeAdventureContent(req.body?.content || req.body?.overrides || {});
    const updated = await GlobalAdventureConfig.findOneAndUpdate(
      { key: GLOBAL_KEY },
      {
        key: GLOBAL_KEY,
        content,
        createdBy: req.user._id,
        updatedBy: req.user._id,
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    return res.status(200).json({
      message: "Global adventure configuration saved.",
      config: resolveAdventureConfig(updated),
      resolved: resolveAdventureConfig(updated),
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to save global adventure config.", error: error.message });
  }
};

export const getGlobalAdventureConfig = async (req, res) => {
  try {
    const config = await GlobalAdventureConfig.findOne({ key: GLOBAL_KEY });
    return res.status(200).json({ resolved: config ? resolveAdventureConfig(config) : null });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch global adventure config.", error: error.message });
  }
};
