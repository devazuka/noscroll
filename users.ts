import { db } from './db.ts'

// auto associate users
const associateGithubAndJiraUsers = () => {
  const userStats = db.query(`
  SELECT issue.assignee, a.name, pr.user
  FROM issue
  LEFT JOIN pr ON issue.id = pr.issue
  LEFT JOIN user as a ON issue.assignee = a.jira
  WHERE a.github IS NULL
    AND pr.issue NOT NULL
    AND assignee NOT NULL
    AND pr.user NOT NULL
  `)

  const occurences = {}
  for (const [assignee, name, coder] of userStats) {
    const match = occurences[assignee] || (occurences[assignee] = {})
    match[coder] = (match[coder] || 0) + 1
  }

  const x = Object.fromEntries(userStats)

  for (const [assignee, matches] of Object.entries(occurences)) {
    let max = 0, matchedCoder = ''
    for (const [coder, count] of Object.entries(matches)) {
      if (count > max) {
        matchedCoder = coder
        max = count
      }
    }
    // db.query(`DELETE FROM user WHERE github = ?`, [matchedCoder])
    console.log({ match: matchedCoder, with: x[assignee] })
    db.query(`UPDATE user SET github = ? WHERE jira = ?`, [matchedCoder, assignee])
  }
  // find pr with issues for user without jira accounts
  // compare issue assignee and pr user (ignore jira user with already a github account)
  // find the one that is most common and don't already have a link
}

associateGithubAndJiraUsers()