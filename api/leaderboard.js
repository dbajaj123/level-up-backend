// Persistent storage using Vercel Blob
import { put, list } from '@vercel/blob';

// Blob storage key
const BLOB_KEY = 'leaderboard-data.json';

// Benchmark score for point calculation
const BENCHMARK_SCORE = 0.5;

// Calculate points based on formula: 100 * (delta / (2 - p)) + 5T
// where delta = score - benchmark, p = accuracy score, T = time bonus in hours
function calculatePoints(cvScore, benchmark = BENCHMARK_SCORE, timeBonusHours = 0) {
    if (cvScore <= benchmark) {
        return 0; // No points if below benchmark
    }
    
    const delta = cvScore - benchmark;
    const p = cvScore;
    const T = timeBonusHours;
    
    const points = 100 * (delta / (2 - p)) + 5 * T;
    return Math.max(0, points); // Ensure non-negative
}

// Helper functions for Blob storage
async function getData() {
  try {
    const { blobs } = await list();
    
    if (!blobs || blobs.length === 0) {
      return {
        leaderboardData: [],
        sotaScore: 0,
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
        historicalScores: {},
        activityLog: []
      };
    }
    
    const response = await fetch(dataBlob.url);
    
    if (!response.ok || response.status === 404) {
      return {
        leaderboardData: [],
        sotaScore: 0,
        historicalScores: {},
        activityLog: []
      };
    }
    
    const text = await response.text();
    
    if (text.includes('Blob not found') || text.includes('blob does not exist')) {
      return {
        leaderboardData: [],
        sotaScore: 0,
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
      historicalScores: {},
      activityLog: []
    };
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
        
        res.status(200).json({
          success: true,
          data: {
            leaderboardData: allData.leaderboardData || [],
            sotaScore: allData.sotaScore || 0,
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
        let historicalScores = {};
        let activityLog = currentData.activityLog || [];

        // Update SOTA score
        for (const score of scores) {
          if (score.cvScore > sotaScore) {
            sotaScore = score.cvScore;
          }
        }

        // Update leaderboard - process as fresh data
        const participantMap = new Map();

        // Process new scores
        console.log('Processing', scores.length, 'scores:', scores.map(s => ({ name: s.name, cvScore: s.cvScore })));
        
        for (const score of scores) {
          const existing = participantMap.get(score.name);
          
          // Calculate points for this submission (no time bonus in point calculation)
          const newSubmissionPoints = calculatePoints(score.cvScore, BENCHMARK_SCORE, 0);

          if (existing) {
            // Always process new submissions, even if score doesn't improve
            // Add points for this submission to cumulative total
            const previousTotalPoints = existing.totalPoints || 0;
            
            if (score.cvScore > existing.cvScore) {
              // This is their new best score
              existing.cvScore = score.cvScore;
              existing.improvement = score.cvScore - BENCHMARK_SCORE;
              existing.lastSubmissionPoints = newSubmissionPoints;
              existing.totalPoints = previousTotalPoints + newSubmissionPoints;
              existing.timestamp = score.timestamp;
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
          sotaScore
        });
        
        await saveData({
          leaderboardData,
          sotaScore,
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
            participantsUpdated: scores.length
          }
        });
        break;

      case 'DELETE':
        // Reset leaderboard (admin only - add auth in production)
        await saveData({
          leaderboardData: [],
          sotaScore: 0,
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
