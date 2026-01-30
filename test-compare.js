const bcrypt = require('bcrypt');

const hash = '$2b$10$8KqxMZ0YkJ5lDZ0VQk5zQu7pTdKz5X.zJxKqVw5KqP5.zJxKqVw5K';
const password = 'student123';

bcrypt.compare(password, hash, (err, res) => {
  if (err) {
    console.error('Error comparing:', err);
    process.exit(2);
  }
  console.log('Password matches hash?', res);
});
