# Status Checker

This is the monitoring part of my status system available at https://github.com/Raraph84/Status-Website

## Setup

### Prerequisites

- The database set up (done if you already set up the API)
- The panel set up to create the entries (optional if you want to create them in the database manually)
- Git installed to clone the repo
- NodeJS installed to run the checker

### Preparing

Clone the repo and install the libs by running:

```bash
git clone https://github.com/Raraph84/Status-Checker
cd Status-Checker/
npm install
```

Create a new MySQL user with edit access to the database for the checker  
Create the checker on the panel with the settings you want (or insert a new line in the `checkers` table)

Copy the `Status-Checker/.env.example` to `Status-Checker/.env` and fill it with your database credentials, a Discord webhook URL to alert you when a service is up or down, and the checker id to match the one you created in the database

Then start the checker by running:

```bash
node index.js
```

You can now create some services to check, and assign them to the checker by creating a group and associating the service and the checker to the group
