# Copyright (C) 2026 Raimond Brookman and contributors
# SPDX-License-Identifier: GPL-3.0-or-later

# Multi-stage: build the jar with maven-on-temurin-21, then ship the slim JRE.
# Layer order is deliberate: pom.xml first so dependency resolution is cached
# across source-only edits.

FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY pom.xml ./
RUN mvn -B -DskipTests dependency:go-offline
COPY src ./src
RUN mvn -B -DskipTests package

FROM eclipse-temurin:21-jre-jammy
WORKDIR /app
# spring-boot-maven-plugin's `repackage` goal renames the layout-friendly jar.
COPY --from=build /build/target/solver-*.jar /app/app.jar

EXPOSE 8080

# Container healthcheck duplicates the compose-side check so `docker ps` shows
# the right state even when run standalone.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=10 \
    CMD wget -qO- http://localhost:8080/actuator/health | grep -q '"status":"UP"' || exit 1

ENTRYPOINT ["java", "-jar", "/app/app.jar"]
