import mongoose from 'mongoose';

const QuizQuestionSchema = new mongoose.Schema({
  id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
  question: { type: String, required: true, maxlength: 600 },
  options: [{ type: String, required: true, maxlength: 300 }],
  correctAnswer: { type: Number, required: true, min: 0, max: 10 },
  explanation: { type: String, default: '', maxlength: 1000 }
}, { _id: false });

const EvaluationCriteriaSchema = new mongoose.Schema({
  components: {
    required: [{
      type: { type: String, required: true },
      count: { type: Number, default: 1, min: 1, max: 50 }
    }],
    weight: { type: Number, default: 0.25 }
  },
  wiringAccuracy: {
    requiredConnections: [{
      from: {
        component: { type: String },
        pin: { type: String },
        terminal: { type: String }
      },
      to: {
        component: { type: String },
        pin: { type: String },
        terminal: { type: String }
      }
    }],
    weight: { type: Number, default: 0.35 }
  },
  codeFunctionality: {
    requiredFunctions: [{ type: String }],
    expectedBehavior: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    weight: { type: Number, default: 0.40 }
  },
  scoring: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }
}, { _id: false, strict: false });

const MissionSchema = new mongoose.Schema({
  id: { type: String, required: true },
  slug: { type: String, required: true, lowercase: true, trim: true },
  title: { type: String, required: true, maxlength: 140 },
  subtitle: { type: String, default: '', maxlength: 240 },
  description: { type: String, default: '', maxlength: 2000 },
  xpReward: { type: Number, default: 100, min: 10, max: 2000 },
  difficulty: {
    type: String,
    enum: ['beginner', 'intermediate', 'advanced', 'expert'],
    default: 'beginner'
  },
  icon: { type: String, default: 'Lightbulb' },
  islandImage: { type: String, default: '/gamification_images/island_led.png' },
  theory: {
    title: { type: String, default: '', maxlength: 200 },
    contentMarkdown: { type: String, default: '', maxlength: 30000 },
    keyTakeaways: [{ type: String, maxlength: 400 }]
  },
  quizQuestions: { type: [QuizQuestionSchema], default: [] },
  componentsToUnlock: [{ type: String }],
  guideSample: {
    title: { type: String, default: 'Guided Sample Lab' },
    instruction: { type: String, default: '' },
    starterCode: { type: String, default: '' },
    circuitPngBase64: { type: String, default: '' },
    circuitFileName: { type: String, default: '' }
  },
  projectMission: {
    title: { type: String, default: 'Final Project Challenge' },
    prompt: { type: String, default: '' },
    tasks: { type: [mongoose.Schema.Types.Mixed], default: [] },
    // Teacher solution parsed from OpenHW PNG steganography
    solutionCircuit: {
      circuitPngBase64: { type: String, default: '' },
      circuitFileName: { type: String, default: '' },
      components: { type: [mongoose.Schema.Types.Mixed], default: [] },
      wires: { type: [mongoose.Schema.Types.Mixed], default: [] },
      code: { type: String, default: '' },
      summary: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }
    }
  },
  starterCode: { type: String, default: '' },
  evaluationCriteria: { type: EvaluationCriteriaSchema, default: () => ({}) }
}, { _id: false, strict: false });

const IslandSchema = new mongoose.Schema({
  id: { type: Number, required: true },
  name: { type: String, required: true, maxlength: 100 },
  theme: { type: String, default: 'Beginner', maxlength: 80 },
  color: { type: String, default: '#3b82f6' },
  islandImage: { type: String, default: '/gamification_images/island_led.png' },
  missions: { type: [MissionSchema], default: [] }
}, { _id: false });

const WorldSchema = new mongoose.Schema({
  id: { type: Number, required: true },
  name: { type: String, required: true, maxlength: 100 }, // e.g. "Circuit Basics"
  theme: { type: String, default: 'Beginner', maxlength: 80 },
  color: { type: String, default: '#22c55e' },
  islands: {
    type: [IslandSchema],
    validate: [val => val.length <= 6, '{PATH} exceeds the limit of 6 islands per world']
  }
}, { _id: false });

const CertificateConfigSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  title: { type: String, default: '', maxlength: 150 },
  issuerName: { type: String, default: '', maxlength: 100 },
  description: { type: String, default: '', maxlength: 600 },
  accentColor: { type: String, default: '#6366f1' },
  badgeIcon: { type: String, default: 'Award' }
}, { _id: false });

const AdventureMapSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 140 },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  description: { type: String, default: '', maxlength: 2000 },
  board: {
    type: String,
    enum: ['arduino-uno', 'esp32', 'raspberry-pi-pico', 'stm32', 'other'],
    required: true,
    index: true
  },
  chipArchitecture: { type: String, default: '8-BIT AVR RISC', maxlength: 80 },
  campaignCode: { type: String, default: 'COMM-01', maxlength: 30 },
  coverImage: { type: String, default: '' },
  badgeColor: { type: String, default: '#10b981' },
  
  // Ownership & visibility
  creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  creatorName: { type: String, required: true },
  isOfficial: { type: Boolean, default: false, index: true },
  isPublic: { type: Boolean, default: true, index: true },
  status: { type: String, enum: ['draft', 'published', 'archived'], default: 'published', index: true },

  // ── Scope & Classroom Binding ────────────────────────────────────────────────
  // 'public'    → visible to everyone (default for community maps)
  // 'classroom' → only visible/playable by students enrolled in classroomId
  scope: {
    type: String,
    enum: ['public', 'classroom'],
    default: 'public',
    index: true,
  },
  // Only set when scope === 'classroom'. References the Class document.
  classroomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Class',
    default: null,
    index: true,
  },
  
  // Worlds & Islands hierarchy: Worlds contain up to 6 islands
  worlds: { type: [WorldSchema], default: [] },
  islands: { type: [IslandSchema], default: [] }, // fallback/direct array
  certification: { type: CertificateConfigSchema, default: () => ({}) },
  
  // Social & Stats
  playCount: { type: Number, default: 0, min: 0 },
  likesCount: { type: Number, default: 0, min: 0 },
  tags: [{ type: String, lowercase: true, trim: true, maxlength: 40 }]
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});


// Production Indexes
AdventureMapSchema.index({ isPublic: 1, status: 1, board: 1, createdAt: -1 });
AdventureMapSchema.index({ isPublic: 1, status: 1, isOfficial: -1, playCount: -1 });
AdventureMapSchema.index({ title: 'text', description: 'text', tags: 'text' });

export default mongoose.model('AdventureMap', AdventureMapSchema);
