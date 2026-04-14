-- TeachingBoard MySQL schema
CREATE DATABASE IF NOT EXISTS teachingboard;
USE teachingboard;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  role ENUM('admin', 'student') NOT NULL,
  pin VARCHAR(20) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user_role_name (role, name)
);

CREATE TABLE IF NOT EXISTS questions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  question TEXT NOT NULL,
  option1 VARCHAR(255) NOT NULL,
  option2 VARCHAR(255) NOT NULL,
  option3 VARCHAR(255) NOT NULL,
  option4 VARCHAR(255) NOT NULL,
  answer ENUM('option1', 'option2', 'option3', 'option4') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_question_text (question(191))
);

CREATE TABLE IF NOT EXISTS results (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_name VARCHAR(100) NOT NULL,
  score INT NOT NULL,
  total INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users (name, role, pin)
VALUES ('TeachingBoard Admin', 'admin', '1234')
ON DUPLICATE KEY UPDATE pin = VALUES(pin);

INSERT INTO questions (question, option1, option2, option3, option4, answer)
VALUES
  (
    'What is 2 + 2?',
    '3',
    '4',
    '5',
    '6',
    'option2'
  ),
  (
    'Which planet is known as the Red Planet?',
    'Earth',
    'Venus',
    'Mars',
    'Jupiter',
    'option3'
  )
ON DUPLICATE KEY UPDATE question = VALUES(question);
