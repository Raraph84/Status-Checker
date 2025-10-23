# Status Checker

This is the monitoring part of my status system available at https://github.com/Raraph84/Status-Website

## Setup

### Prerequisites

- The API setup to configure the MySQL database
- Git installed to clone the repo
- NodeJS installed to run the API

### Preparing

Clone the repo and install the libs by running:

```bash
git clone https://github.com/Raraph84/Status-Checker
cd Status-Checker/
npm install
```

Create a new MySQL user with edit access to the database created for the API  
Insert a new line in the `checkers` table with the settings you want

Copy the `Status-Checker/.env.example` to `Status-Checker/.env` and fill it with your database credentials, a Discord webhook URL to alert you when a service is up or down, and the checker id to match the one you created in the database

Then start the checker by running:

```bash
node index.js
```
