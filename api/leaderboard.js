// Persistent storage using Vercel Blob
import { put, list } from '@vercel/blob';

// Blob storage key
const BLOB_KEY = 'leaderboard-data.json';

// Benchmark score for point calculation
const BENCHMARK_SCORE = 0.5;

// Time bonus: 5 points per hour holding SOTA
const TIME_BONUS_RATE = 1;

// Calculate points based on formula: 10000 * (delta / (2 - p)) + 5T
// where delta = score - current SOTA, p = current SOTA score, T = time bonus in hours
function calculatePoints(cvScore, currentSota = BENCHMARK_SCORE, timeBonusHours = 0) {
    if (cvScore <= currentSota) {
        return 0; // No points if doesn't beat current SOTA
    }
    
    const delta = cvScore - currentSota;
    const p = currentSota; // p is the current SOTA score being beaten
    const T = timeBonusHours;
    
    const points = 10000 * (delta / (2 - p)) + 5 * T;
    return Math.max(0, points); // Ensure non-negative
}

// Calculate CV bonus: 100 * (max CV score)
function calculateCvBonus(cvScore) {
    return 100 * cvScore;
}

// Helper functions for Blob storage
async function getData() {
  try {
    const { blobs } = await list();
    
    if (!blobs || blobs.length === 0) {
      return {
        leaderboardData: [],
        sotaScore: 0,
        sotaHolder: null,
        sotaAchievedAt: null,
        historicalScores: {},
        activityLog: []
      };
    }
    
    // Find exact match first, then prefix match
    let dataBlob = blobs.find(b => b.pathname === BLOB_KEY);
    if (!dataBlob) {
      dataBlob = blobs.find(b => b.pathname.startsWith('leaderboard-data'));
    }
    
    if (!dataBlob) {
      return {
        leaderboardData: [],
        sotaScore: 0,
        sotaHolder: null,
        sotaAchievedAt: null,
        historicalScores: {},
        activityLog: []
      };
    }
    
    const response = await fetch(dataBlob.url);
    
    if (!response.ok || response.status === 404) {
      return {
        leaderboardData: [],
        sotaScore: 0,
        sotaHolder: null,
        sotaAchievedAt: null,
        historicalScores: {},
        activityLog: []
      };
    }
    
    const text = await response.text();
    
    if (text.includes('Blob not found') || text.includes('blob does not exist')) {
      return {
        leaderboardData: [],
        sotaScore: 0,
        sotaHolder: null,
        sotaAchievedAt: null,
        historicalScores: {},
        activityLog: []
      };
    }
    
    return JSON.parse(text);
  } catch (error) {
    console.error('Error getting data:', error.message);
    return {
      leaderboardData: [],
      sotaScore: 0,
      sotaHolder: null,
      sotaAchievedAt: null,
      historicalScores: {},
      activityLog: []
    };
  }
}

// Calculate time bonus based on how long a submission held SOTA
// This will be calculated during POST processing
function calculateSotaHoldingBonus(durationMs) {
  if (!durationMs || durationMs <= 0) return 0;
  
  const hoursHeld = durationMs / (1000 * 60 * 60);
  
  return TIME_BONUS_RATE * hoursHeld;
}

// Parse WhatsApp timestamp format (e.g., "05/12/2025, 17:50")
function parseWhatsAppTimestamp(timestamp) {
  if (!timestamp) return null;
  
  try {
    // Handle format: "05/12/2025, 17:50" or "05/12/2025, 17:50:00"
    // Also handle: "[05/12/2025, 17:50]" or "05/12/2025, 17:50 AM"
    const cleanTimestamp = timestamp.replace(/[\[\]]/g, '').trim();
    
    // Parse DD/MM/YYYY, HH:mm format (WhatsApp format)
    const match = cleanTimestamp.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})/);
    if (match) {
      const [_, day, month, year, hour, minute] = match;
      // Create date in UTC to avoid timezone issues
      const date = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute)));
      console.log('Parsed timestamp:', timestamp, '-> Date:', date.toISOString(), '-> Now:', new Date().toISOString());
      return date;
    }
    
    // Fallback: try parsing as ISO format
    const date = new Date(cleanTimestamp);
    return isNaN(date.getTime()) ? null : date;
  } catch (error) {
    console.error('Error parsing timestamp:', timestamp, error);
    return null;
  }
}

async function saveData(data) {
  try {
    console.log('Saving data to blob:', data);
    const blob = await put(BLOB_KEY, JSON.stringify(data), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false
    });
    console.log('Data saved successfully to blob:', blob.url, 'pathname:', blob.pathname);
    return blob;
  } catch (error) {
    console.error('Error saving data:', error.message);
    throw error;
  }
}

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { method } = req;

  try {
    switch (method) {
      case 'GET':
        // Get all leaderboard data
        const allData = await getData();
        
        // Apply accumulated time bonus and CV bonus to ALL participants
        let leaderboardWithBonus = (allData.leaderboardData || []).map(participant => {
          // Use the accumulated time bonus from all submissions
          const currentTimeBonus = participant.accumulatedTimeBonus || 0;
          
          // Calculate CV bonus: 100 * (max CV score) - applied once based on best CV score
          const cvBonus = calculateCvBonus(participant.cvScore || 0);
          
          return {
            ...participant,
            currentTimeBonus,
            cvBonus,
            totalPointsWithBonus: (participant.totalPoints || 0) + currentTimeBonus + cvBonus,
            submittedAt: participant.timestamp
          };
        });
        
        // Re-sort with time bonus
        leaderboardWithBonus.sort((a, b) => {
          const pointsA = a.totalPointsWithBonus || a.totalPoints || 0;
          const pointsB = b.totalPointsWithBonus || b.totalPoints || 0;
          if (pointsB !== pointsA) {
            return pointsB - pointsA;
          }
          return b.cvScore - a.cvScore;
        });
        
        res.status(200).json({
          success: true,
          data: {
            leaderboardData: leaderboardWithBonus,
            sotaScore: allData.sotaScore || 0,
            sotaHolder: allData.sotaHolder || null,
            sotaAchievedAt: allData.sotaAchievedAt || null,
            historicalScores: allData.historicalScores || {},
            activityLog: (allData.activityLog || []).slice(0, 10), // Last 10 activities
            lastUpdate: new Date().toISOString()
          }
        });
        break;

      case 'POST':
        // Update leaderboard with new scores
        const { scores, activity, resetLeaderboard } = req.body;

        if (!scores || !Array.isArray(scores)) {
          res.status(400).json({
            success: false,
            message: 'Invalid data format. Expected scores array.'
          });
          return;
        }

        // Load current data
        const currentData = await getData();
        
        // Reset leaderboard if requested (fresh upload)
        let leaderboardData = [];
        let sotaScore = 0;
        let sotaHolder = null;
        let sotaAchievedAt = null;
        let historicalScores = {};
        let activityLog = currentData.activityLog || [];

        // Note: Time bonus is now calculated dynamically on each GET request based on submission timestamps
        // No need to finalize or store time bonus permanently

        // Find new SOTA score and holder
        let newSotaHolder = null;
        for (const score of scores) {
          if (score.cvScore > sotaScore) {
            sotaScore = score.cvScore;
            newSotaHolder = score.name;
          }
        }
        
        // Set new SOTA holder if found
        if (newSotaHolder) {
          sotaHolder = newSotaHolder;
          sotaAchievedAt = new Date().toISOString();
        }

        // Update leaderboard - process as fresh data
        const participantMap = new Map();

        // Process new scores and track submissions with timestamps
        console.log('Processing', scores.length, 'scores:', scores.map(s => ({ name: s.name, cvScore: s.cvScore, timestamp: s.timestamp })));
        
        // First pass: collect all submissions
        const allSubmissions = [];
        for (const score of scores) {
          allSubmissions.push({
            name: score.name,
            cvScore: score.cvScore,
            timestamp: score.timestamp
          });
        }
        
        // Sort submissions by timestamp to process chronologically
        allSubmissions.sort((a, b) => {
          const dateA = parseWhatsAppTimestamp(a.timestamp);
          const dateB = parseWhatsAppTimestamp(b.timestamp);
          if (!dateA || !dateB) return 0;
          return dateA - dateB;
        });
        
        // Track SOTA changes and calculate holding durations
        let currentSotaScore = 0;
        let currentSotaHolder = null;
        let currentSotaStartTime = null;
        const sotaHoldingPeriods = []; // Track all SOTA periods
        
        for (const submission of allSubmissions) {
          const submissionTime = parseWhatsAppTimestamp(submission.timestamp);
          
          if (submission.cvScore > currentSotaScore) {
            // End previous SOTA period if exists
            if (currentSotaHolder && currentSotaStartTime) {
              const holdingDuration = submissionTime - currentSotaStartTime;
              sotaHoldingPeriods.push({
                name: currentSotaHolder,
                score: currentSotaScore,
                startTime: currentSotaStartTime,
                endTime: submissionTime,
                duration: holdingDuration
              });
            }
            
            // Start new SOTA period
            currentSotaScore = submission.cvScore;
            currentSotaHolder = submission.name;
            currentSotaStartTime = submissionTime;
          }
        }
        
        // Handle the current SOTA holder (still holding)
        if (currentSotaHolder && currentSotaStartTime) {
          const now = new Date();
          const holdingDuration = now - currentSotaStartTime;
          sotaHoldingPeriods.push({
            name: currentSotaHolder,
            score: currentSotaScore,
            startTime: currentSotaStartTime,
            endTime: now,
            duration: holdingDuration,
            isCurrent: true
          });
        }
        
        // Calculate accumulated time bonuses based on SOTA holding periods
        const sotaBonusByParticipant = new Map();
        for (const period of sotaHoldingPeriods) {
          const bonus = calculateSotaHoldingBonus(period.duration);
          const currentBonus = sotaBonusByParticipant.get(period.name) || 0;
          sotaBonusByParticipant.set(period.name, currentBonus + bonus);
        }
        
        console.log('SOTA Holding Periods:', sotaHoldingPeriods);
        console.log('SOTA Bonuses by Participant:', Array.from(sotaBonusByParticipant.entries()));
        
        // Second pass: build participant data with points calculated against SOTA at submission time
        // Process submissions chronologically to track SOTA progression
        let sotaProgressionMap = new Map(); // Track SOTA score at each timestamp
        let currentSotaAtTime = BENCHMARK_SCORE;
        
        for (const submission of allSubmissions) {
          // Update SOTA if this submission beats current SOTA
          if (submission.cvScore > currentSotaAtTime) {
            currentSotaAtTime = submission.cvScore;
          }
          sotaProgressionMap.set(submission.timestamp, currentSotaAtTime);
        }
        
        for (const score of scores) {
          const existing = participantMap.get(score.name);
          
          // Find SOTA at the time of this submission by looking backwards chronologically
          let sotaAtSubmissionTime = BENCHMARK_SCORE;
          const submissionTime = parseWhatsAppTimestamp(score.timestamp);
          
          // Find the SOTA just before this submission
          for (const submission of allSubmissions) {
            const subTime = parseWhatsAppTimestamp(submission.timestamp);
            if (subTime < submissionTime) {
              // This submission happened before our current one
              if (submission.cvScore > sotaAtSubmissionTime) {
                sotaAtSubmissionTime = submission.cvScore;
              }
            } else if (subTime.getTime() === submissionTime.getTime() && submission.name !== score.name) {
              // Same timestamp but different person (shouldn't happen but handle it)
              if (submission.cvScore > sotaAtSubmissionTime) {
                sotaAtSubmissionTime = submission.cvScore;
              }
            }
          }
          
          // Calculate points for this submission against the SOTA at that time
          const newSubmissionPoints = calculatePoints(score.cvScore, sotaAtSubmissionTime, 0);

          if (existing) {
            // Always process new submissions, even if score doesn't improve
            // Add points for this submission to cumulative total
            const previousTotalPoints = existing.totalPoints || 0;
            
            // Always update to the latest timestamp for display purposes
            const existingTime = parseWhatsAppTimestamp(existing.timestamp);
            const newTime = parseWhatsAppTimestamp(score.timestamp);
            if (newTime && (!existingTime || newTime > existingTime)) {
              existing.timestamp = score.timestamp;
            }
            
            if (score.cvScore > existing.cvScore) {
              // This is their new best score
              existing.cvScore = score.cvScore;
              existing.improvement = score.cvScore - BENCHMARK_SCORE;
              existing.lastSubmissionPoints = newSubmissionPoints;
              existing.totalPoints = previousTotalPoints + newSubmissionPoints;
              existing.submissionCount = (existing.submissionCount || 1) + 1;

              // Track historical improvement
              if (!historicalScores[score.name]) {
                historicalScores[score.name] = [];
              }
              historicalScores[score.name].push({
                score: score.cvScore,
                improvement: existing.improvement,
                pointsEarned: newSubmissionPoints,
                totalPoints: existing.totalPoints,
                timestamp: score.timestamp
              });
            } else {
              // Score didn't improve, but still add points for the submission
              existing.lastSubmissionPoints = newSubmissionPoints;
              existing.totalPoints = previousTotalPoints + newSubmissionPoints;
              existing.submissionCount = (existing.submissionCount || 1) + 1;
              
              // Track this submission too
              if (!historicalScores[score.name]) {
                historicalScores[score.name] = [];
              }
              historicalScores[score.name].push({
                score: score.cvScore,
                improvement: 0,
                pointsEarned: newSubmissionPoints,
                totalPoints: existing.totalPoints,
                timestamp: score.timestamp,
                noImprovement: true
              });
            }
          } else {
            // New participant - first submission
            participantMap.set(score.name, {
              name: score.name,
              cvScore: score.cvScore,
              improvement: score.cvScore - BENCHMARK_SCORE,
              lastSubmissionPoints: newSubmissionPoints,
              totalPoints: newSubmissionPoints,
              submissionCount: 1,
              timestamp: score.timestamp,
              isNew: true
            });

            if (!historicalScores[score.name]) {
              historicalScores[score.name] = [];
            }
            historicalScores[score.name].push({
              score: score.cvScore,
              improvement: score.cvScore - BENCHMARK_SCORE,
              pointsEarned: newSubmissionPoints,
              totalPoints: newSubmissionPoints,
              timestamp: score.timestamp
            });
          }
        }
        
        // Apply SOTA holding bonuses to participants
        for (const [name, bonus] of sotaBonusByParticipant.entries()) {
          const participant = participantMap.get(name);
          if (participant) {
            participant.accumulatedTimeBonus = bonus;
          }
        }
        
        // Set accumulatedTimeBonus to 0 for participants who never held SOTA
        for (const participant of participantMap.values()) {
          if (!participant.accumulatedTimeBonus) {
            participant.accumulatedTimeBonus = 0;
          }
        }

        // Convert map back to array and sort by total points (primary) and CV score (secondary)
        console.log('ParticipantMap size:', participantMap.size, 'Contents:', Array.from(participantMap.entries()));
        leaderboardData = Array.from(participantMap.values());
        console.log('LeaderboardData after conversion:', leaderboardData.length, 'items');
        
        leaderboardData.sort((a, b) => {
          // Primary: Total Points (descending)
          const pointsA = a.totalPoints || 0;
          const pointsB = b.totalPoints || 0;
          if (pointsB !== pointsA) {
            return pointsB - pointsA;
          }
          // Secondary: CV Score (descending)
          return b.cvScore - a.cvScore;
        });

        // Add activity
        if (activity) {
          activityLog.unshift({
            ...activity,
            timestamp: new Date().toISOString()
          });
          if (activityLog.length > 50) {
            activityLog = activityLog.slice(0, 50);
          }
        }

        // Save all data
        console.log('Saving leaderboard data:', {
          participantCount: leaderboardData.length,
          participants: leaderboardData.map(p => ({ name: p.name, cvScore: p.cvScore, totalPoints: p.totalPoints })),
          sotaScore,
          sotaHolder,
          sotaAchievedAt
        });
        
        await saveData({
          leaderboardData,
          sotaScore,
          sotaHolder,
          sotaAchievedAt,
          historicalScores,
          activityLog
        });
        
        console.log('Data saved successfully');

        res.status(200).json({
          success: true,
          message: `Updated ${scores.length} score(s)`,
          data: {
            leaderboardData,
            sotaScore,
            sotaHolder,
            sotaAchievedAt,
            participantsUpdated: scores.length
          }
        });
        break;

      case 'DELETE':
        // Reset leaderboard (admin only - add auth in production)
        await saveData({
          leaderboardData: [],
          sotaScore: 0,
          sotaHolder: null,
          sotaAchievedAt: null,
          historicalScores: {},
          activityLog: []
        });

        res.status(200).json({
          success: true,
          message: 'Leaderboard reset successfully'
        });
        break;

      default:
        res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
        res.status(405).json({
          success: false,
          message: `Method ${method} Not Allowed`
        });
    }
  } catch (error) {
    console.error('API Error:', error);
    
    // Ensure CORS headers are set on error responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
