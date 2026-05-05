import crypto from "crypto";
import jwt from "jsonwebtoken";
import Class from "../models/Class.js";
import LiveSimulationSession from "../models/LiveSimulationSession.js";
import User from "../models/User.js";

let geoip = null;
try {
  geoip = await import("geoip-lite");
} catch (e) {
  // geoip-lite not installed yet
}

const LIVE_SESSION_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const sessionsByCode = new Map();
const sessionClients = new Map();

const normalizeSnapshot = (payload = {}) => ({
  name: String(payload.name || "Live Simulation").trim() || "Live Simulation",
  board: payload.board || "arduino_uno",
  components: Array.isArray(payload.components) ? payload.components : [],
  connections: Array.isArray(payload.connections) ? payload.connections : [],
  code: typeof payload.code === "string" ? payload.code : "",
  projectFiles: Array.isArray(payload.projectFiles) ? payload.projectFiles : [],
  openCodeTabs: Array.isArray(payload.openCodeTabs) ? payload.openCodeTabs : [],
  activeCodeFileId:
    typeof payload.activeCodeFileId === "string" ? payload.activeCodeFileId : "",
});

const toUserId = (user) => String(user?._id || user?.id || "").trim();

const toEntityId = (value) => String(value?._id || value || "").trim();

const setsHaveSameValues = (left = new Set(), right = new Set()) => {
  if (left.size !== right.size) return false;
  return Array.from(left).every((entry) => right.has(entry));
};

const syncSessionMembershipFromClassroom = async (session, classroom) => {
  if (!session || !classroom) return;

  const classStudentIds = new Set(
    (classroom.students || [])
      .map((student) => toEntityId(student))
      .filter(Boolean),
  );
  const classStudentRoster = new Map(
    (classroom.students || [])
      .map((student) => [
        toEntityId(student),
        student?.name || session.studentRoster?.get?.(toEntityId(student)) || "Student",
      ])
      .filter(([userId]) => Boolean(userId)),
  );
  const classTeacherId = toEntityId(classroom.teacher);
  const className = classroom.name || session.className;

  const membershipChanged =
    !setsHaveSameValues(session.studentIds || new Set(), classStudentIds) ||
    String(session.teacherId || "") !== classTeacherId ||
    session.className !== className;

  if (!membershipChanged) return;

  session.studentIds = classStudentIds;
  session.studentRoster = classStudentRoster;
  session.editorStudentIds = new Set(
    Array.from(session.editorStudentIds || []).filter((userId) => classStudentIds.has(userId)),
  );
  session.pendingEditRequests = new Map(
    Array.from(session.pendingEditRequests?.entries?.() || []).filter(([userId]) =>
      classStudentIds.has(userId),
    ),
  );
  session.teacherId = classTeacherId || session.teacherId;
  session.className = className;
  session.updatedAt = new Date();

  await persistLiveSimulationSession(session);
};

const hydrateSession = (record) => {
  if (!record) return null;

  const rosterEntries = Array.isArray(record.studentRoster) ? record.studentRoster : [];
  return {
    sessionCode: String(record.sessionCode || "").trim().toUpperCase(),
    classId: String(record.classId || ""),
    className: record.className || "Live Class",
    teacherId: String(record.teacherId || ""),
    teacherName: record.teacherName || "Teacher",
    studentIds: new Set((record.studentIds || []).map((entry) => String(entry))),
    studentRoster: new Map(
      rosterEntries.map((entry) => [String(entry.userId || ""), entry.userName || "Student"]),
    ),
    editorStudentIds: new Set((record.editorStudentIds || []).map((entry) => String(entry))),
    pendingEditRequests: new Map(
      (record.pendingEditRequests || []).map((entry) => [
        String(entry.userId || ""),
        {
          userId: String(entry.userId || ""),
          userName: entry.userName || "Student",
          requestedAt: entry.requestedAt ? new Date(entry.requestedAt).toISOString() : new Date().toISOString(),
        },
      ]),
    ),
    snapshot: normalizeSnapshot(record.snapshot),
    createdAt: record.createdAt ? new Date(record.createdAt) : new Date(),
    updatedAt: record.updatedAt ? new Date(record.updatedAt) : new Date(),
  };
};

const serializePermissionState = (session) => {
  const grantedEditorIds = Array.from(session.editorStudentIds || []);
  return {
    grantedEditorIds,
    grantedEditors: grantedEditorIds.map((userId) => ({
      userId,
      userName: session.studentRoster?.get?.(userId) || "Student",
    })),
    pendingEditRequests: Array.from(session.pendingEditRequests?.values?.() || []),
  };
};

const saveQueue = new Set();
let isSaving = false;

const processSaveQueue = async () => {
  if (isSaving || saveQueue.size === 0) return;
  isSaving = true;
  const sessionCode = saveQueue.values().next().value;
  saveQueue.delete(sessionCode);

  try {
    const session = sessionsByCode.get(sessionCode);
    if (session) {
      await persistLiveSimulationSession(session);
    }
  } catch (error) {
    console.error("[liveSimulation] Background save failed:", error);
  } finally {
    isSaving = false;
    if (saveQueue.size > 0) setTimeout(processSaveQueue, 100);
  }
};

const queueSessionSave = (sessionCode) => {
  saveQueue.add(sessionCode);
  processSaveQueue();
};

const persistLiveSimulationSession = async (session) => {
  if (!session?.sessionCode) return;

  await LiveSimulationSession.findOneAndUpdate(
    { sessionCode: session.sessionCode },
    {
      sessionCode: session.sessionCode,
      classId: session.classId,
      className: session.className,
      teacherId: session.teacherId,
      teacherName: session.teacherName,
      studentIds: Array.from(session.studentIds || []),
      studentRoster: Array.from(session.studentRoster?.entries?.() || []).map(([userId, userName]) => ({
        userId,
        userName,
      })),
      editorStudentIds: Array.from(session.editorStudentIds || []),
      pendingEditRequests: Array.from(session.pendingEditRequests?.values?.() || []).map((entry) => ({
        userId: entry.userId,
        userName: entry.userName,
        requestedAt: entry.requestedAt || new Date().toISOString(),
      })),
      snapshot: normalizeSnapshot(session.snapshot),
      updatedAt: session.updatedAt || new Date(),
      ip: session.ip,
      lat: session.lat,
      lng: session.lng
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

const generateSessionCode = () => {
  let output = "";
  for (let index = 0; index < 6; index += 1) {
    const randomIndex = crypto.randomInt(0, LIVE_SESSION_CODE_ALPHABET.length);
    output += LIVE_SESSION_CODE_ALPHABET[randomIndex];
  }
  return output;
};

const sendJson = (socket, payload) => {
  try {
    if (socket?.readyState === 1) {
      socket.send(JSON.stringify(payload));
    }
  } catch (error) {
    console.warn("[liveSimulation] Failed to send WS payload:", error?.message || error);
  }
};

const getClientsForSession = (sessionCode) => sessionClients.get(sessionCode) || new Set();

const buildParticipantCounts = (sessionCode) => {
  let teachers = 0;
  let students = 0;
  let others = 0;

  getClientsForSession(sessionCode).forEach((socket) => {
    if (socket?.liveMeta?.role === "teacher") {
      teachers += 1;
    } else if (socket?.liveMeta?.role === "student") {
      students += 1;
    } else {
      others += 1;
    }
  });

  return {
    total: teachers + students + others,
    teachers,
    students,
    others,
  };
};

const broadcastParticipantCounts = (sessionCode) => {
  const counts = buildParticipantCounts(sessionCode);
  getClientsForSession(sessionCode).forEach((socket) => {
    sendJson(socket, {
      type: "session:participants",
      participantCounts: counts,
    });
  });
};

const broadcastSessionUpdate = (sessionCode, payload, exceptSocket = null) => {
  getClientsForSession(sessionCode).forEach((socket) => {
    if (socket === exceptSocket) return;
    sendJson(socket, payload);
  });
};

const canSocketEditSession = (socket, session) => {
  const role = socket?.liveMeta?.role || "";
  const userId = String(socket?.liveMeta?.userId || "").trim();

  if (role === "teacher" || role === "admin") return true;
  if (role !== "student" || !userId) return false;

  return session?.editorStudentIds?.has?.(userId) || false;
};

const parseCookieToken = (cookieHeader = "") => {
  if (!cookieHeader) return null;
  const jwtCookie = cookieHeader
    .split(";")
    .find((cookie) => cookie.trim().startsWith("jwt="));
  return jwtCookie ? jwtCookie.split("=")[1] || null : null;
};

const resolveSocketUser = async (request) => {
  const url = new URL(request.url, "http://localhost");
  const queryToken = url.searchParams.get("token");
  const authHeader = request.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;
  const cookieToken = parseCookieToken(request.headers.cookie || "");
  const token = queryToken || bearerToken || cookieToken;

  if (!token) {
    throw new Error("Unauthorized: No token provided");
  }

  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const user = await User.findById(decoded.id).select("-password").lean();
  if (!user) {
    throw new Error("Unauthorized: User not found");
  }

  return user;
};

export const getLiveSimulationSession = async (sessionCode) => {
  if (!sessionCode) return null;
  const normalizedCode = String(sessionCode).trim().toUpperCase();
  if (sessionsByCode.has(normalizedCode)) {
    return sessionsByCode.get(normalizedCode) || null;
  }

  const record = await LiveSimulationSession.findOne({ sessionCode: normalizedCode }).lean();
  const session = hydrateSession(record);
  if (session) {
    sessionsByCode.set(normalizedCode, session);
  }
  return session;
};

export const assertLiveSessionAccess = async (
  sessionCode,
  user,
  { requireTeacherHost = false } = {},
) => {
  const normalizedCode = String(sessionCode || "").trim().toUpperCase();
  const session = await getLiveSimulationSession(normalizedCode);
  if (!session) {
    const error = new Error("Live simulation session not found.");
    error.status = 404;
    throw error;
  }

  const currentUserId = toUserId(user);
  const classroom = session.classId
    ? await Class.findById(session.classId)
        .select("name teacher students")
        .populate("students", "_id name")
        .lean()
    : null;

  if (classroom) {
    await syncSessionMembershipFromClassroom(session, classroom);
  }

  const classStudentIds = classroom
    ? new Set((classroom.students || []).map((student) => toEntityId(student)).filter(Boolean))
    : null;
  const classTeacherId = classroom ? toEntityId(classroom.teacher) : "";
  const isTeacher = classroom
    ? (classTeacherId === currentUserId || user.role === "admin")
    : (String(session.teacherId) === currentUserId || user.role === "admin");
  const isStudent = classroom
    ? classStudentIds.has(currentUserId)
    : session.studentIds.has(currentUserId);

  if (!isTeacher && !isStudent) {
    const error = new Error("You do not have access to this live simulation.");
    error.status = 403;
    throw error;
  }

  if (requireTeacherHost && !isTeacher) {
    const error = new Error("Only the class teacher can host this live simulation.");
    error.status = 403;
    throw error;
  }

  return session;
};

export const createLiveSimulationSession = async ({ classId, teacher, snapshot, ip = null }) => {
  if (!teacher?._id || (teacher.role !== "teacher" && teacher.role !== "admin")) {
    const error = new Error("Only teachers or admins can start a live simulation.");
    error.status = 403;
    throw error;
  }

  const classroom = await Class.findById(classId)
    .populate("teacher", "name")
    .populate("students", "_id name")
    .lean();

  if (!classroom) {
    const error = new Error("Classroom not found.");
    error.status = 404;
    throw error;
  }

  if (String(classroom.teacher?._id || classroom.teacher) !== String(teacher._id) && teacher.role !== "admin") {
    const error = new Error("Only the class teacher or an admin can start a live simulation.");
    error.status = 403;
    throw error;
  }

  let sessionCode = generateSessionCode();
  while (sessionsByCode.has(sessionCode)) {
    sessionCode = generateSessionCode();
  }

  let lat = null, lng = null;
  if (ip && geoip) {
    const geo = geoip.lookup(ip);
    if (geo) {
      lat = geo.ll[0];
      lng = geo.ll[1];
    }
  }

  const nextSession = {
    sessionCode,
    classId: String(classroom._id),
    className: classroom.name || "Live Class",
    teacherId: String(teacher._id),
    teacherName: classroom.teacher?.name || teacher.name || "Teacher",
    studentIds: new Set((classroom.students || []).map((student) => String(student._id || student))),
    studentRoster: new Map(
      (classroom.students || []).map((student) => [String(student._id || student), student.name || "Student"]),
    ),
    editorStudentIds: new Set(),
    pendingEditRequests: new Map(),
    snapshot: normalizeSnapshot(snapshot),
    ip,
    lat,
    lng,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  sessionsByCode.set(sessionCode, nextSession);
  await persistLiveSimulationSession(nextSession);
  return nextSession;
};

export const serializeLiveSimulationSession = async (sessionCode) => {
  const session = await getLiveSimulationSession(sessionCode);
  if (!session) return null;

  return {
    sessionCode: session.sessionCode,
    classId: session.classId,
    className: session.className,
    teacherName: session.teacherName,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    snapshot: session.snapshot,
    participantCounts: buildParticipantCounts(session.sessionCode),
    permissions: serializePermissionState(session),
  };
};

export async function registerLiveSimulationWebSocket(httpServer) {
  try {
    const wsModule = await import("ws");
    const WebSocketServer = wsModule.WebSocketServer || wsModule.default?.WebSocketServer;
    if (!WebSocketServer) {
      throw new Error("ws module missing WebSocketServer export");
    }

    const liveWss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", async (request, socket, head) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname !== "/api/live-simulations/ws") {
        return;
      }

      try {
        const sessionCode = String(url.searchParams.get("sessionCode") || "")
          .trim()
          .toUpperCase();
        const requestedRole = String(url.searchParams.get("role") || "")
          .trim()
          .toLowerCase();
        const user = await resolveSocketUser(request);
        const session = await assertLiveSessionAccess(sessionCode, user, {
          requireTeacherHost: requestedRole === "teacher",
        });

        liveWss.handleUpgrade(request, socket, head, (ws) => {
          ws.liveMeta = {
            sessionCode,
            role:
              requestedRole === "teacher" || user.role === "admin"
                ? "teacher"
                : user.role === "student"
                  ? "student"
                  : "viewer",
            userId: String(user._id),
            userName: user.name || user.email || "Participant",
          };
          liveWss.emit("connection", ws, request, { session });
        });
      } catch (error) {
        const status = error?.status || 401;
        socket.write(
          `HTTP/1.1 ${status} ${error?.message || "Unauthorized"}\r\nConnection: close\r\n\r\n`,
        );
        socket.destroy();
      }
    });

    liveWss.on("connection", async (ws, _request, { session }) => {
      const sessionCode = session.sessionCode;
      const sessionSet = getClientsForSession(sessionCode);
      sessionSet.add(ws);
      sessionClients.set(sessionCode, sessionSet);

      sendJson(ws, {
        type: "session:welcome",
        session: await serializeLiveSimulationSession(sessionCode),
        role: ws.liveMeta?.role || "viewer",
      });
      broadcastParticipantCounts(sessionCode);

      ws.on("message", async (rawPayload) => {
        try {
          const payload = JSON.parse(String(rawPayload || "{}"));
          if (payload.type === "teacher:sync" || payload.type === "student:sync") {
            const existingSession = await getLiveSimulationSession(sessionCode);
            if (!existingSession) return;

            const requestedByTeacher = payload.type === "teacher:sync";
            if (requestedByTeacher) {
              if (ws.liveMeta?.role !== "teacher") return;
            } else if (!canSocketEditSession(ws, existingSession)) {
              return;
            }

            existingSession.snapshot = normalizeSnapshot(payload.snapshot);
            existingSession.updatedAt = new Date();
            queueSessionSave(sessionCode);

            broadcastSessionUpdate(
              sessionCode,
              {
                type: "session:update",
                snapshot: existingSession.snapshot,
                updatedAt: existingSession.updatedAt,
                sourceRole: ws.liveMeta?.role || "teacher",
                sourceUserId: String(ws.liveMeta?.userId || ""),
              },
              ws,
            );
            broadcastParticipantCounts(sessionCode);
          }

          if (payload.type === "student:request-edit") {
            if (ws.liveMeta?.role !== "student") return;

            const existingSession = await getLiveSimulationSession(sessionCode);
            if (!existingSession) return;

            const requestUserId = String(ws.liveMeta?.userId || "");
            if (!requestUserId) return;
            if (existingSession.editorStudentIds.has(requestUserId)) {
              sendJson(ws, {
                type: "permissions:update",
                permissions: serializePermissionState(existingSession),
              });
              return;
            }

            if (!existingSession.pendingEditRequests.has(requestUserId)) {
              existingSession.pendingEditRequests.set(requestUserId, {
                userId: requestUserId,
                userName: ws.liveMeta?.userName || "Student",
                requestedAt: new Date().toISOString(),
              });
            }

            await persistLiveSimulationSession(existingSession);

            broadcastSessionUpdate(sessionCode, {
              type: "permissions:update",
              permissions: serializePermissionState(existingSession),
            });
          }

          if (payload.type === "teacher:respond-edit-request" || payload.type === "teacher:set-student-edit-access") {
            if (ws.liveMeta?.role !== "teacher") return;

            const existingSession = await getLiveSimulationSession(sessionCode);
            if (!existingSession) return;

            const targetUserId = String(payload.userId || "").trim();
            const decision = String(payload.decision || "").trim().toLowerCase();
            const approved = decision === "approve";
            const revoked = decision === "revoke";
            if (!targetUserId) return;

            existingSession.pendingEditRequests.delete(targetUserId);
            if (approved) {
              existingSession.editorStudentIds.add(targetUserId);
            } else {
              existingSession.editorStudentIds.delete(targetUserId);
            }

            await persistLiveSimulationSession(existingSession);

            broadcastSessionUpdate(sessionCode, {
              type: "permissions:update",
              permissions: serializePermissionState(existingSession),
              decision: approved ? "approve" : revoked ? "revoke" : "deny",
              userId: targetUserId,
            });
          }

          if (payload.type === "student:end-edit-access") {
            const existingSession = await getLiveSimulationSession(sessionCode);
            if (!existingSession) return;

            const targetUserId = String(ws.liveMeta?.userId || "").trim();
            if (!targetUserId) return;

            existingSession.pendingEditRequests.delete(targetUserId);
            existingSession.editorStudentIds.delete(targetUserId);
            await persistLiveSimulationSession(existingSession);

            broadcastSessionUpdate(sessionCode, {
              type: "permissions:update",
              permissions: serializePermissionState(existingSession),
              decision: "revoke",
              userId: targetUserId,
            });
          }

          if (payload.type === "session:ping") {
            sendJson(ws, { type: "session:pong", ts: Date.now() });
          }
        } catch (error) {
          console.warn("[liveSimulation] Invalid WS payload:", error?.message || error);
        }
      });

      ws.on("close", () => {
        const activeSet = getClientsForSession(sessionCode);
        activeSet.delete(ws);
        if (activeSet.size === 0) {
          sessionClients.delete(sessionCode);
        } else {
          sessionClients.set(sessionCode, activeSet);
        }
        broadcastParticipantCounts(sessionCode);
      });
    });

    console.log("Live simulation WebSocket server ready on /api/live-simulations/ws");
    return true;
  } catch (error) {
    console.warn(
      "Live simulation WebSocket server unavailable. Install 'ws' to enable live meetings.",
      error?.message || error,
    );
    return false;
  }
}
