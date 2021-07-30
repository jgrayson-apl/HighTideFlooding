/*
  Copyright 2017 Esri

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

define([
  "calcite",
  "dojo/_base/declare",
  "ApplicationBase/ApplicationBase",
  "dojo/i18n!./nls/resources",
  "ApplicationBase/support/itemUtils",
  "ApplicationBase/support/domHelper",
  "dojo/dom-construct",
  "esri/identity/IdentityManager",
  "esri/core/Accessor",
  "esri/core/Evented",
  "esri/core/watchUtils",
  "esri/core/promiseUtils",
  "esri/layers/Layer",
  "esri/Graphic",
  "esri/layers/GraphicsLayer",
  "esri/views/MapView",
  "esri/widgets/TimeSlider"
], function(calcite, declare, ApplicationBase, i18n,
            itemUtils, domHelper, domConstruct,
            IdentityManager, Accessor, Evented, watchUtils, promiseUtils,
            Layer, Graphic, GraphicsLayer, MapView, TimeSlider){

  //
  // DEFAULT APP PARAMS //
  //
  const DefaultAppParams = Accessor.createSubclass({
    properties: {
      baseUrl: { type: String },
      station: { type: Number },
      year: { type: Number }
    },
    constructor: function(){
      this.baseUrl = `${window.location.origin}${window.location.pathname}`;
    },
    setStation: function({ station, year }){
      this.station = station;
      this.year = year;
    },
    toShareURL: function(){
      const params = [];
      if(this.station){
        params.push(`station=${encodeURIComponent(this.station)}`);
      }
      if(this.year){
        params.push(`year=${encodeURIComponent(this.year)}`);
      }
      return `${encodeURI(this.baseUrl)}${params.length ? '?' : ''}${params.join('&')}`;
    }
  });

  return declare([Evented], {

    /**
     *
     */
    constructor: function(){
      // BASE //
      this.base = null;
      // CALCITE WEB //
      calcite.init();
    },

    /**
     *
     * @param base
     */
    init: function(base){
      if(!base){
        console.error("ApplicationBase is not defined");
        return;
      }
      this.base = base;

      domHelper.setPageLocale(this.base.locale);
      domHelper.setPageDirection(this.base.direction);

      // WEB MAP //
      const webMapItem = this.base.results.webMapItems[0].value;

      // TITLE & DESCRIPTION //
      this.base.config.title = (this.base.config.title || itemUtils.getItemTitle(webMapItem));
      domHelper.setPageTitle(this.base.config.title);
      document.getElementById("app-details-panel").innerHTML = webMapItem.description;
      document.querySelectorAll('.app-title').forEach(n => {n.innerHTML = this.base.config.title.toUpperCase();});


      // APPLICATION ITEM //
      const portalItem = this.base.results.applicationItem.value;
      const appProxies = (portalItem && portalItem.appProxies) ? portalItem.appProxies : null;

      // CREATE MAP //
      itemUtils.createMapFromItem({ item: webMapItem, appProxies: appProxies }).then(map => {

        // STARTUP DIALOG //
        this.initializeStartupDialog();

        // APPLICATION READY //
        return this.applicationReady(map);
      });

    },

    /**
     *
     */
    initializeStartupDialog: function(){

      // APP NAME //
      const pathParts = location.pathname.split('/');
      const appName = `show-startup-${pathParts[pathParts.length - 2]}`;

      // STARTUP DIALOG //
      const showStartup = localStorage.getItem(appName) || 'show';
      if(showStartup === 'show'){
        calcite.bus.emit('modal:open', { id: 'app-details-dialog' });
      }

      // HIDE STARTUP DIALOG //
      const hideStartupInput = document.getElementById('hide-startup-input');
      hideStartupInput.checked = (showStartup === 'hide');
      hideStartupInput.addEventListener('change', () => {
        localStorage.setItem(appName, hideStartupInput.checked ? 'hide' : 'show');
      });

    },

    /**
     * APPLICATION READY
     *
     * @param map
     */
    applicationReady: function(map){
      return promiseUtils.create((resolve, reject) => {

        // DEFAULT PARAMS //
        this.defaultParams = new DefaultAppParams();

        // SHARING //
        this.initializeSharing();

        const excludedLayers = ['Background'];
        const scenarioLayers = map.layers.reverse().filter(layer => { return !excludedLayers.includes(layer.title); });

        promiseUtils.eachAlways(scenarioLayers.map(scenarioLayer => {
          return scenarioLayer.load().then(() => {
            scenarioLayer.outFields = ["*"];
            return scenarioLayer;
          });
        })).then(() => {

          // SELECTION LAYER //
          this.initializeSelectionLayer(map);

          const layerInfos = scenarioLayers.reduce((infos, layer, layerIdx) => {

            // SCENARIO LABEL //
            const scenarioLabel = layer.title.split(' ')[0];

            // MAP VIEW //
            const mapView = this.createLayerMapView(map, layer, (layerIdx === (scenarioLayers.length - 1)));
            infos.mapViews.push(mapView);

            // LAYER MAPVIEW INFOS //
            infos.layerMapViewInfos.push({ scenarioLabel, layer, mapView });

            // TIME INFO //
            if(layer.timeInfo){
              infos.timeExtent.start = Math.min(infos.timeExtent.start, layer.timeInfo.fullTimeExtent.start.valueOf());
              infos.timeExtent.end = Math.max(infos.timeExtent.end, layer.timeInfo.fullTimeExtent.end.valueOf());
            }

            // SCENARIO LABELS //
            infos.scenarioLabels.push(scenarioLabel.split('-'));

            return infos;
          }, { scenarioLabels: [], layerMapViewInfos: [], mapViews: [], timeExtent: { start: Infinity, end: -Infinity } });


          // BOOKMARKS //
          this.initializeBookmarks(map, layerInfos.mapViews);

          // CHART //
          this.initializeChart(layerInfos.scenarioLabels);

          // FULL TIME EXTENT //
          const fullTimeExtent = { start: new Date(layerInfos.timeExtent.start), end: new Date(layerInfos.timeExtent.end) };
          // TIME SLIDER //
          this.initializeTimeSlider(fullTimeExtent);

          // SYNCED VIEWS //
          this.initializeSyncedViews(layerInfos.mapViews);

          // ALL MAPVIEW INTERACTIONS //
          this.initializeInteractions(layerInfos.layerMapViewInfos);


          // RESOLVE //
          resolve();
        });
      });
    },

    /**
     *
     * @param map
     */
    initializeSelectionLayer: function(map){

      const selectionGraphic = new Graphic({
        symbol: {
          type: 'simple-marker',
          size: '26px',
          color: 'transparent',
          outline: {
            color: 'rgba(255,255,255,0.9)',
            width: '3.5px'
          }
        }
      });
      const selectionLayer = new GraphicsLayer({ title: 'selection', visible: true, graphics: [selectionGraphic] });
      map.add(selectionLayer);

      this.setSelectionLocation = location => {
        selectionGraphic.geometry = location;
      };

    },

    /**
     *
     */
    initializeSharing: function(){

      // GET URL PARAMETERS //
      const urlParams = new URLSearchParams(window.location.search);
      if(urlParams.has('station')){
        this.defaultParams.station = Number(urlParams.get('station'));
      }
      if(urlParams.has('year')){
        this.defaultParams.year = Number(urlParams.get('year'));
      }

      //
      // https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API
      //
      // SET SHARING URL //
      const sharePanel = document.getElementById('share-panel');
      const shareLink = document.getElementById('share-link');
      shareLink.addEventListener('click', () => {
        const shareURL = this.defaultParams.toShareURL();
        navigator.clipboard.writeText(shareURL).then(() => {
          navigator.clipboard.readText().then((clipText) => {
            //console.info("SHARE URL COPIED TO CLIPBOARD: ", clipText);
            sharePanel.classList.add('animate-in-down');
            sharePanel.classList.remove('hide');
            setTimeout(() => {
              sharePanel.classList.remove('animate-in-down');
              sharePanel.classList.add('animate-fade-out');
              setTimeout(() => {
                sharePanel.classList.remove('animate-fade-out');
                sharePanel.classList.add('hide');
              }, 1000);
            }, 2500);

          });
        }, console.error);
      });

    },

    /**
     *
     * @param map
     * @param mapViews
     */
    initializeBookmarks: function(map, mapViews){

      // USE FIRST MAP //
      const firstMapView = mapViews[0];

      // firstMapView.watch('extent.center.longitude', longitude => {
      //   console.info(longitude, firstMapView.zoom);
      // })

      // GOTO OPTIONS //
      const goToOptions = { duration: 1500, easing: 'ease-in-out' };

      // GO TO STATION //
      this.on('go-to-station', ({ location, zoom }) => {
        if(location){
          firstMapView.goTo({ center: location, zoom: zoom }, goToOptions);
        }
      });

      // DO WE HAVE BOOKMARKS? //
      if(map.bookmarks){

        // ZOOM TO BOOKMARK //
        const zoomToBookmark = (bookmarkOrName, clearSelection) => {

          const bookmark = (bookmarkOrName.hasOwnProperty('viewpoint'))
            ? bookmarkOrName
            : map.bookmarks.find(b => b.name === bookmarkOrName);

          let goToParams = (bookmark.name === 'PACIFIC ISLANDS')
            ? { center: [179.824442118734, bookmark.viewpoint.targetGeometry.center.latitude], zoom: 3.0 }
            : { target: bookmark.viewpoint };

          firstMapView.goTo(goToParams, goToOptions).then(() => {
            clearSelection && this.emit('location-change', { stationFeature: null });
          });
        };

        // BOOKMARKS PANEL //
        const bookmarksPanel = document.getElementById('bookmarks-panel');

        // FOR EACH BOOKMARK //
        map.bookmarks.forEach(bookmark => {
          // CREATE BOOKMARK BUTTON //
          const bookmarkNode = domConstruct.create('div', {
            className: 'btn btn-white btn-fill',
            innerHTML: bookmark.name,
            title: `zoom to '${bookmark.name.toLowerCase()}'...`
          }, bookmarksPanel);
          bookmarkNode.addEventListener('click', () => {
            zoomToBookmark(bookmark, true);
          });
        });

        // RESET //
        const resetBtn = document.getElementById('reset-btn');
        resetBtn.addEventListener('click', () => {
          zoomToBookmark('MAINLAND USA', true);
        });
      }

    },

    /**
     *
     * @param map
     * @param layer
     * @param setDefault
     * @returns {*}
     */
    createLayerMapView: function(map, layer, setDefault){

      const viewsContainer = document.getElementById('views-container');

      const layerMapView = new MapView({
        container: domConstruct.create('div', { className: 'view-panel panel panel-theme' }, viewsContainer),
        map: map,
        ui: { components: [] },
        constraints: { snapToZoom: false },
        highlightOptions: {
          color: 'transparent', fillOpacity: 0.0,
          haloColor: '#EBEDED', haloOpacity: 1.0
        },
        popup: { autoOpenEnabled: false }
      });
      layerMapView.when(() => {

        // CURSOR //
        layerMapView.container.style.cursor = 'pointer';

        // LAYER TITLE PANEL //
        const layerTitlePanel = domConstruct.create('div', {
          className: 'title-panel panel panel-theme panel-no-padding panel-no-border font-size--2',
          innerHTML: layer.title
        });
        layerMapView.ui.add(layerTitlePanel, 'manual');

        // LOADING //
        const loadingNode = domConstruct.create("div", { className: "loader is-active" });
        domConstruct.create("div", { className: "loader-bars" }, loadingNode);
        domConstruct.create("div", { className: "loader-text font-size--3 no-letter-spacing", innerHTML: "LOADING..." }, loadingNode);
        layerMapView.ui.add(loadingNode, "manual");
        watchUtils.whenNotOnce(layerMapView, 'updating', () => {
          loadingNode.classList.remove("is-active");
        });

        // ALL LAYERVIEWS VISIBILITY //
        layerMapView.map.layers.forEach((lyr) => {
          layerMapView.whenLayerView(lyr).then((lyrView) => {
            lyrView.visible = (lyrView.layer.id === layer.id) || (lyrView.layer.title === 'selection');
          });
        });

        // SET INITIAL TIME EXTENT //
        layerMapView.timeExtent = this.getCurrentTimeExtent();
        // TIME EXTENT CHANGE //
        this.on('time-extent-change', ({ timeExtent }) => {
          layerMapView.timeExtent = timeExtent;
        });

        // STATIONS BY NOAA ID //
        const stationFeaturesByID = new Map();

        // GET STATION FROM LAYER //
        const _getStationFeature = (stationId) => {
          return promiseUtils.create((resolve, reject) => {
            if(stationId){
              let stationFeature = stationFeaturesByID.get(stationId);
              if(stationFeature){
                resolve({ stationFeature });
              } else {
                const stationQuery = layer.createQuery();
                stationQuery.set({ where: `(NOAA_ID = ${stationId})` });
                layer.queryFeatures(stationQuery).then(stationFS => {
                  if(stationFS.features.length){
                    stationFeature = stationFS.features[0];
                    stationFeaturesByID.set(stationId, stationFeature);
                    resolve({ stationFeature });
                  } else {
                    resolve({ stationFeature: null });
                  }
                }).catch(error => {
                  resolve({ stationFeature: null });
                });
              }
            } else {
              resolve({ stationFeature: null });
            }
          });
        }

        // WHEN LAYERVIEW //
        layerMapView.whenLayerView(layer).then(layerView => {

          // MAPVIEW CLICK //
          layerMapView.on('click', clickEvt => {
            layerMapView.hitTest(clickEvt, { include: [layer] }).then(hitResponse => {
              if(hitResponse.results.length){
                _getStationFeature(hitResponse.results[0].graphic.attributes.NOAA_ID).then(({ stationFeature }) => {
                  this.emit('location-change', { stationFeature });
                });
              } else {
                this.emit('location-change', { stationFeature: null });
              }
            });
          });

          // INITIAL DEFAULT STATION //
          if(setDefault && this.defaultParams.station){
            watchUtils.whenFalseOnce(layerView, 'updating', () => {
              _getStationFeature(this.defaultParams.station).then(({ stationFeature }) => {
                this.emit('location-change', { stationFeature });
              });
            });
          }

        });
      });

      return layerMapView;
    },

    /**
     *
     * @param layerMapViewInfos
     */
    initializeInteractions: function(layerMapViewInfos){

      // STATION FEATURE //
      let _stationFeature = null;

      // ZOOM TO STATION //
      const zoomBtn = document.getElementById('zoom-btn');
      zoomBtn.addEventListener('click', () => {
        this.emit('go-to-station', { location: _stationFeature.geometry, zoom: 13 });
      });

      // MAPVIEW INTERACTIONS //
      const getFeatureHandles = layerMapViewInfos.map((layerMapViewInfo) => {
        return this.initializeMapViewInteraction(layerMapViewInfo);
      });
      Promise.all(getFeatureHandles).then(getFeatures => {

        // UPDATE INFORMATION //
        const updateInformation = promiseUtils.debounce(() => {
          return promiseUtils.create((resolve, reject) => {

            // STATION NAME //
            const stationName = _stationFeature ? _stationFeature.attributes.Station_Name : null;
            const stationID = _stationFeature ? _stationFeature.attributes.NOAA_ID : null;

            Promise.all(getFeatures.map(getFeature => { return getFeature(stationName); })).then(allLocationInfos => {
              const validLocationInfos = allLocationInfos.filter(locationInfo => { return (locationInfo.oid != null); });
              if(validLocationInfos.length){

                // YEAR //
                const year = validLocationInfos[0].year;

                // CHART DATA //
                const chartData = validLocationInfos.reduce((data, locationInfo) => {
                  return data.concat({ y: locationInfo.scenarioLabel, x: locationInfo.floodDays });
                }, []);

                this.defaultParams.setStation({ station: stationID, year });
                this.emit('location-infos', { stationID, stationName, year, chartData });
                resolve();
              } else {
                this.defaultParams.setStation({ station: null, year: null });
                this.emit('location-infos', {});
                reject();
              }
            });
          });
        });

        // LOCATION SELECTED //
        this.on('location-change', ({ stationFeature }) => {

          // STATION FEATURE //
          _stationFeature = stationFeature;
          zoomBtn.classList.toggle('btn-disabled', (_stationFeature == null));

          this.setSelectionLocation(_stationFeature ? _stationFeature.geometry : null);

          updateInformation().then(() => {
            this.emit('go-to-station', { location: _stationFeature.geometry, zoom: 7 });
          }).catch(error => {
            if(error && (error.name !== 'AbortError')){ console.error(error);}
          });

        });

        // TIME EXTENT CHANGE //
        this.on('time-extent-change', ({ timeExtent }) => {
          updateInformation().catch(error => {
            if(error && (error.name !== 'AbortError')){ console.error(error); }
          });
        });

      });

    },

    /**
     *
     * @param scenarioLabel
     * @param layer
     * @param mapView
     */
    initializeMapViewInteraction: function({ scenarioLabel, layer, mapView }){
      return mapView.whenLayerView(layer).then(layerView => {

        // FLOODED DAYS FIELD INFO //
        const floodDaysFieldInfo = layer.popupTemplate.fieldInfos.find(fi => (fi.label === 'Flood Days per Year'));

        // HIGHLIGHT //
        //let _highlightHandle = null;

        return (stationName) => {
          return promiseUtils.create((resolve, reject) => {
            if(stationName){
              watchUtils.whenNotOnce(layerView, 'updating').then(() => {

                const stationQuery = layerView.createQuery();
                stationQuery.set({ where: `(Station_Name = '${stationName}')` });
                layerView.queryFeatures(stationQuery).then(stationsFS => {
                  if(stationsFS.features.length){
                    // STATION FEATURE //
                    const stationFeature = stationsFS.features[0];
                    const stationID = stationFeature.attributes.NOAA_ID;

                    // HIGHLIGHT //
                    //_highlightHandle && _highlightHandle.remove();
                    //_highlightHandle = layerView.highlight(stationFeature);

                    // LOCATION INFO //
                    resolve({
                      oid: stationFeature.getObjectId(),
                      stationID: stationID,
                      scenarioLabel: scenarioLabel,
                      floodDays: stationFeature.attributes[floodDaysFieldInfo.fieldName],
                      year: (new Date(stationFeature.attributes.Date)).getUTCFullYear()
                    });

                  } else {
                    //_highlightHandle && _highlightHandle.remove();
                    resolve({});
                  }
                });
              });
            } else {
              //_highlightHandle && _highlightHandle.remove();
              resolve({});
            }
          });
        };

      });
    },

    /**
     *  https://chartjs-plugin-datalabels.netlify.app/
     */
    initializeChart: function(scenarioLabels){

      const defaultChartColor = '#EBEDED';
      const defaultChartThemeColor = '#7acaed';

      const getLabelOptions = function(days){

        // LABEL OPTIONS //
        let labelOptions = {};

        // COLORS //
        switch(true){
          case days >= 180:
            labelOptions = {
              backgroundColor: '#d63229',
              borderColor: 'rgba(214,50,41,0.5)'
            }
            break;
          case days >= 90:
            labelOptions = {
              backgroundColor: '#f38449',
              borderColor: 'rgba(243,132,73,0.5)'
            }
            break;
          case days >= 30:
            labelOptions = {
              backgroundColor: '#f8e35b',
              borderColor: 'rgba(248,227,91,0.5)'
            }
            break;
          default:
            labelOptions = {
              backgroundColor: '#7abee5',
              borderColor: 'rgba(123,190,229,0.5)'
            };
        }

        // DAYS LENGTH  [1,2,3]
        const daysLength = String(days).length;

        // PADDING //
        labelOptions.padding = { top: 0, bottom: 0, right: 0, left: 0 };
        switch(daysLength){
          case 1:
            labelOptions.padding = { top: 3, bottom: 0, right: 5, left: 5 };
            break;
          case 2:
            labelOptions.padding = { top: 5, bottom: 2, right: 4, left: 4 };
            break;
          case 3:
            labelOptions.padding = { top: 7, bottom: 4, right: 2, left: 2 };
            break;
        }

        return labelOptions;
      }

      Chart.defaults.global.defaultFontFamily = "'Avenir Next LT Pro Light'";
      Chart.defaults.global.defaultFontSize = 11;
      Chart.defaults.global.defaultFontColor = defaultChartColor;
      Chart.defaults.global.defaultFontStyle = 'normal';

      // CHART NODE //
      const chartNode = document.getElementById('flood-days-chart-node');

      // FLOOD DAYS CHART //
      const floodDaysChart = new Chart(chartNode, {
        type: 'horizontalBar',
        data: {
          labels: scenarioLabels,
          datasets: [{
            backgroundColor: '#191A1F',
            borderColor: defaultChartColor,
            borderWidth: 1.2,
            borderSkipped: false,
            datalabels: {
              anchor: 'end',
              align: 'center',
              textAlign: 'center',
              clip: false,
              font: { size: 12, weight: 600 },
              color: '#191A1F',
              offset: 0,
              borderWidth: 10,
              borderRadius: 50,
              backgroundColor: function(context){
                const days = context.dataset.data[context.dataIndex].x;
                return getLabelOptions(days).backgroundColor;
              },
              borderColor: function(context){
                const days = context.dataset.data[context.dataIndex].x;
                return getLabelOptions(days).borderColor;
              },
              padding: function(context){
                const days = context.dataset.data[context.dataIndex].x;
                return getLabelOptions(days).padding;
              }
            },
            data: []
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animationDuration: 1000,
          animation: { duration: 1000 },
          hover: { animationDuration: 1000 },
          responsiveAnimationDuration: 1000,
          title: {
            display: false
          },
          legend: { display: false },
          elements: { rectangle: { borderWidth: 2 } },
          tooltips: {
            enabled: false,
            backgroundColor: '#3a3d46',
            titleFontSize: 17,
            titleFontColor: defaultChartColor,
            titleAlign: 'center',
            titleMarginBottom: 10,
            bodyFontSize: 15,
            bodyFontColor: defaultChartThemeColor,
            bodySpacing: 8,
            callbacks: {
              title: function(tooltipItem, data){
                return tooltipItem[0].label.replace(/-/, ' ');
              },
              label: function(tooltipItem, data){
                const values = data.datasets[tooltipItem.datasetIndex].data[tooltipItem.index];
                return ` ${values.x} flood days`;
              }
            }
          },
          plugins: {
            datalabels: {
              formatter: function(value, context){ return value.x; }
            }
          },
          scales: {
            yAxes: [
              {
                gridLines: {
                  zeroLineColor: defaultChartColor,
                  color: 'transparent'
                },
                ticks: {
                  fontSize: 13
                }
              }
            ],
            xAxes: [{
              gridLines: {
                zeroLineColor: defaultChartColor,
                color: defaultChartColor
              },
              ticks: {
                padding: 5,
                beginAtZero: true,
                max: 400,
                fontColor: defaultChartColor
              }
            }]
          }
        }
      });

      // DEFAULT CHART TITLE //
      const defaultTitle = 'FLOOD DAYS PER YEAR';
      // CHART TITLE //
      const floodDaysLabel = document.getElementById('flood-days-label');
      // STATION LABEL //
      const stationLabel = document.getElementById('station-label');

      // LOCATION INFOS //
      this.on('location-infos', ({ stationID, stationName, year, chartData }) => {

        if(chartData){
          stationLabel.innerHTML = stationName.toUpperCase();
          stationLabel.title = stationID;
          floodDaysLabel.innerHTML = `FLOOD DAYS IN ${year}`;
          floodDaysChart.data.datasets[0].data = chartData;
        } else {
          stationLabel.innerHTML = '';
          stationLabel.title = '';
          floodDaysLabel.innerHTML = defaultTitle;
          floodDaysChart.data.datasets[0].data = [];
        }
        floodDaysChart.update();

      });

    },

    /**
     *
     * @param fullTimeExtent
     */
    initializeTimeSlider: function(fullTimeExtent){

      // START YEAR //
      const startYear = this.defaultParams.year || (new Date()).getUTCFullYear();
      // START DATE //
      const startDate = new Date(fullTimeExtent.start);
      startDate.setUTCFullYear(startYear);

      // TIME SLIDER //
      const sliderContainer = document.getElementById('slider-container');
      const timeSlider = new TimeSlider({
        container: sliderContainer,
        mode: "instant",
        playRate: 333,
        fullTimeExtent: fullTimeExtent,
        stops: { interval: { unit: 'years', value: 1 } },
        values: [startDate]
      });
      timeSlider.watch("timeExtent", promiseUtils.debounce(timeExtent => {
        this.emit("time-extent-change", { timeExtent });
      }));

      this.getCurrentTimeExtent = () => { return timeSlider.timeExtent; };

    },

    /**
     *
     * @returns {{add: add}}
     */
    initializeSyncedViews: function(mapViews){

      const synchronizeView = (view, others) => {
        others = Array.isArray(others) ? others : [others];

        let viewpointWatchHandle;
        let viewStationaryHandle;
        let otherInteractHandlers;
        let scheduleId;

        const clear = () => {
          if(otherInteractHandlers){
            otherInteractHandlers.forEach((handle) => {
              handle.remove();
            });
          }
          viewpointWatchHandle && viewpointWatchHandle.remove();
          viewStationaryHandle && viewStationaryHandle.remove();
          scheduleId && clearTimeout(scheduleId);
          otherInteractHandlers = viewpointWatchHandle = viewStationaryHandle = scheduleId = null;
        };

        const interactWatcher = view.watch('interacting,animation', (newValue) => {
          if(!newValue){ return; }
          if(viewpointWatchHandle || scheduleId){ return; }

          if(!view.animation){
            others.forEach((otherView) => {
              otherView.viewpoint = view.viewpoint;
            });
          }

          // start updating the other views at the next frame
          scheduleId = setTimeout(() => {
            scheduleId = null;
            viewpointWatchHandle = view.watch('viewpoint', (newValue) => {
              others.forEach((otherView) => {
                otherView.viewpoint = newValue;
              });
            });
          }, 0);

          // stop as soon as another view starts interacting, like if the user starts panning
          otherInteractHandlers = others.map((otherView) => {
            return watchUtils.watch(otherView, 'interacting,animation', (value) => {
              if(value){ clear(); }
            });
          });

          // or stop when the view is stationary again
          viewStationaryHandle = watchUtils.whenTrue(view, 'stationary', clear);
        });

        return {
          remove: () => {
            this.remove = () => {
            };
            clear();
            interactWatcher.remove();
          }
        }
      };

      const synchronizeViews = (views) => {

        let handles = views.map((view, idx, views) => {
          const others = views.concat();
          others.splice(idx, 1);
          return synchronizeView(view, others);
        });

        return {
          remove: () => {
            this.remove = () => {
            };
            handles.forEach((h) => {
              h.remove();
            });
            handles = null;
          }
        }
      };

      const views = [...mapViews];
      let sync_views_handle = synchronizeViews(views);

      return {
        add: (view) => {
          sync_views_handle && sync_views_handle.remove();
          views.push(view);
          sync_views_handle = synchronizeViews(views);
        }
      };

    }

  });
});
